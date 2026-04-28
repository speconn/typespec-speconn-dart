import {
  EmitContext,
  emitFile,
  listServices,
  getNamespaceFullName,
  navigateTypesInNamespace,
  Model,
  Operation,
  Namespace,
  Interface,
  Program,
  Type,
  Scalar,
  IntrinsicType,
} from "@typespec/compiler";

export type EmitterOptions = {
  "emitter-output-dir": string;
};

interface FieldInfo {
  name: string;
  type: Type;
  optional: boolean;
}

interface RpcInfo {
  name: string;
  originalName: string;
  path: string;
  inputType: Model | null;
  outputType: Model | null;
  isStream: boolean;
}

interface ServiceInfo {
  namespace: Namespace;
  iface: Interface;
  serviceName: string;
  serviceFQN: string;
  rpcs: RpcInfo[];
  models: Model[];
}

interface FileNames {
  types: string;
  server: string;
  client: string;
}

function isStreamOp(_program: Program, op: Operation): boolean {
  const returnModel = op.returnType;
  if (returnModel && returnModel.kind === "Model" && returnModel.name && returnModel.name.includes("Stream")) return true;
  return false;
}

function resolveInputModel(op: Operation): Model | null {
  if (op.parameters && op.parameters.kind === "Model") {
    const params = op.parameters;
    if (params.name && params.name !== "") return params;
    if (params.sourceModels && params.sourceModels.length > 0) {
      for (const sm of params.sourceModels) {
        const src = sm.model;
        if (src.kind === "Model" && src.name && src.name !== "") return src;
      }
    }
    if (params.sourceModel && params.sourceModel.name && params.sourceModel.name !== "") {
      return params.sourceModel;
    }
  }
  return null;
}

function resolveOutputModel(op: Operation): Model | null {
  if (op.returnType && op.returnType.kind === "Model") return op.returnType;
  return null;
}

function computeProcedurePath(ns: Namespace, iface: Interface, op: Operation): string {
  const nsFQN = getNamespaceFullName(ns);
  return `/${nsFQN}.${iface.name}/${op.name}`;
}

function collectServices(program: Program): ServiceInfo[] {
  const services = listServices(program);
  const result: ServiceInfo[] = [];

  function collectFromNs(ns: Namespace) {
    for (const [, iface] of ns.interfaces) {
      const nsFQN = getNamespaceFullName(ns);
      const serviceName = iface.name;
      const rpcs: RpcInfo[] = [];
      const models: Model[] = [];
      const seen = new Set<string>();

      for (const [opName, op] of iface.operations) {
        const path = computeProcedurePath(ns, iface, op);
        const inputModel = resolveInputModel(op);
        const outputModel = resolveOutputModel(op);

        if (inputModel && inputModel.name && !seen.has(inputModel.name)) {
          models.push(inputModel);
          seen.add(inputModel.name);
        }
        if (outputModel && outputModel.name && !seen.has(outputModel.name)) {
          models.push(outputModel);
          seen.add(outputModel.name);
        }

        rpcs.push({ name: opName.charAt(0).toLowerCase() + opName.slice(1), originalName: opName, path, inputType: inputModel, outputType: outputModel, isStream: isStreamOp(program, op) });
      }

      navigateTypesInNamespace(ns, {
        model: (m: Model) => {
          if (m.name && !seen.has(m.name)) { models.push(m); seen.add(m.name); }
        },
      });

      result.push({ namespace: ns, iface, serviceName, serviceFQN: `${nsFQN}.${serviceName}`, rpcs, models });
    }
  }

  for (const svc of services) collectFromNs(svc.type);

  if (result.length === 0) {
    const globalNs = program.getGlobalNamespaceType();
    for (const [, ns] of globalNs.namespaces) collectFromNs(ns);
    collectFromNs(globalNs);
  }

  return result;
}

function extractFields(model: Model): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [name, prop] of model.properties) {
    fields.push({ name, type: prop.type, optional: prop.optional ?? false });
  }
  return fields;
}

function snakeBase(s: string): string {
  return s.replace(/([A-Z])/g, (m, c, i) => (i ? "_" : "") + c.toLowerCase());
}

function camelBase(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function fileNamesFor(serviceName: string, lang: string): FileNames {
  const lower = camelBase(serviceName);
  const snake = snakeBase(serviceName);
  switch (lang) {
    case "go":
      return { types: `${snake}_types.go`, server: `${snake}_server.go`, client: `${snake}_client.go` };
    case "node":
      return { types: `${lower}.types.ts`, server: `${lower}.server.ts`, client: `${lower}.client.ts` };
    case "web":
      return { types: `${lower}.types.ts`, server: "", client: `${lower}.client.ts` };
    case "python":
      return { types: `${snake}_types.py`, server: `${snake}_server.py`, client: `${snake}_client.py` };
    case "rust":
      return { types: `${snake}_types.rs`, server: `${snake}_server.rs`, client: `${snake}_client.rs` };
    case "kotlin":
      return { types: `${serviceName}Types.kt`, server: "", client: `${serviceName}Client.kt` };
    case "swift":
      return { types: `${serviceName}Types.swift`, server: "", client: `${serviceName}Client.swift` };
    case "dart":
      return { types: `${snake}.types.dart`, server: "", client: `${snake}.client.dart` };
    default:
      return { types: `${snake}_types`, server: `${snake}_server`, client: `${snake}_client` };
  }
}

function isStringType(type: Type): boolean {
  if (type.kind === "Scalar") return (type as Scalar).name === "string";
  if (type.kind === "Intrinsic") return (type as any).name === "string";
  return false;
}

function isIntType(type: Type): boolean {
  if (type.kind === "Scalar") {
    const n = (type as Scalar).name;
    return n === "int8" || n === "int16" || n === "int32" || n === "int64" || n === "uint8" || n === "uint16" || n === "uint32" || n === "uint64" || n === "integer";
  }
  return false;
}

function isFloatType(type: Type): boolean {
  if (type.kind === "Scalar") {
    const n = (type as Scalar).name;
    return n === "float" || n === "float32" || n === "float64" || n === "decimal";
  }
  return false;
}

function isBoolType(type: Type): boolean {
  if (type.kind === "Scalar") return (type as Scalar).name === "boolean";
  if (type.kind === "Intrinsic") return (type as any).name === "boolean";
  return false;
}

function isArrayType(type: Type): boolean {
  return type.kind === "Model" && !!(type as Model).indexer;
}

function arrayElementType(type: Type): Type {
  if (type.kind === "Model" && (type as Model).indexer) return (type as Model).indexer!.value;
  return type;
}

function typeToDart(type: Type): string {
  if (isStringType(type)) return "String";
  if (isIntType(type)) return "int";
  if (isFloatType(type)) return "double";
  if (isBoolType(type)) return "bool";
  if (isArrayType(type)) return `List<${typeToDart(arrayElementType(type))}>`;
  if (type.kind === "Model") return type.name || "dynamic";
  return "dynamic";
}

function emitDart(program: Program, services: ServiceInfo[], outputDir: string): Promise<void[]> {
  const promises: Promise<void>[] = [];

  for (const svc of services) {
    if (svc.rpcs.length === 0) continue;
    const fn = fileNamesFor(svc.serviceName, "dart");
    const typesImport = fn.types;

    const types: string[] = [];
    types.push("// Generated by @speconn/typespec-speconn. DO NOT EDIT.\n");
    types.push("import 'package:speconn/speconn.dart';\n");
    for (const m of svc.models) {
      if (!m.name) continue;
      const fields = extractFields(m);
      if (fields.length > 0) {
        types.push(`class ${m.name} {`);
        for (const f of fields) {
          types.push(`  final ${typeToDart(f.type)} ${f.name};`);
        }
        types.push(`  ${m.name}({${fields.map(f => `required this.${f.name}`).join(", ")}});`);
        types.push(`  factory ${m.name}.fromJson(Map<String, dynamic> json) => ${m.name}(`);
        types.push(fields.map(f => `    ${f.name}: json['${f.name}'] as ${typeToDart(f.type)},`).join("\n"));
        types.push(`  );`);
        types.push(`  Map<String, dynamic> toJson() => {`);
        types.push(fields.map(f => `    '${f.name}': ${f.name},`).join("\n"));
        types.push(`  };`);
      } else {
        types.push(`class ${m.name} {`);
        types.push(`  ${m.name}();`);
        types.push(`  factory ${m.name}.fromJson(Map<String, dynamic> _) => ${m.name}();`);
        types.push(`  Map<String, dynamic> toJson() => {};`);
      }
      types.push('}\n');
    }
    types.push(`abstract final class ${svc.serviceName} {`);
    types.push(`  static const name = '${svc.serviceFQN}';`);
    types.push('}\n');

    const client: string[] = [];
    client.push("// Generated by @speconn/typespec-speconn. DO NOT EDIT.\n");
    client.push("import 'package:speconn/speconn.dart';");
    client.push(`import '${typesImport}';\n`);
    client.push(`class ${svc.serviceName}Client {`);
    client.push(`  final UnaryClient _client;`);
    client.push(`  ${svc.serviceName}Client(String baseUrl, {Transport? transport})`);
    client.push(`      : _client = UnaryClient(baseUrl, transport: transport);`);
    for (const rpc of svc.rpcs) {
      const reqName = rpc.inputType?.name || "Object";
      const resName = rpc.outputType?.name || "Object";
      if (rpc.isStream) {
        client.push(`  Stream<${resName}> ${rpc.name}(${reqName} input, {Map<String, String> headers = const {}}) =>`);
        client.push(`      _client.stream('${rpc.path}', input.toJson(), ${resName}.fromJson, headers: headers);`);
      } else {
        client.push(`  Future<${resName}> ${rpc.name}(${reqName} input, {Map<String, String> headers = const {}}) =>`);
        client.push(`      _client.call('${rpc.path}', input.toJson(), ${resName}.fromJson, headers: headers);`);
      }
    }
    client.push('  void close() => _client.close();');
    client.push('}\n');

    promises.push(emitFile(program, { path: `${outputDir}/${fn.types}`, content: types.join("\n") }));
    promises.push(emitFile(program, { path: `${outputDir}/${fn.client}`, content: client.join("\n") }));
  }
  return Promise.all(promises);
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const services = collectServices(program);
  await emitDart(program, services, outputDir);
}
