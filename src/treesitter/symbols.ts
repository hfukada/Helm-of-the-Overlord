import type { Node } from "web-tree-sitter";

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "method" | "type" | "interface" | "enum" | "struct" | "trait" | "const" | "variable";
  line: number;
  exported: boolean;
}

/** Filter null entries from namedChildren */
function children(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

function nonNullChildren(node: Node): Node[] {
  return node.children.filter((c): c is Node => c !== null);
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

function isExported(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return parent.type === "export_statement";
}

function extractTSSymbols(root: Node): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function walk(node: Node): void {
    switch (node.type) {
      case "function_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          symbols.push({ name, kind: "function", line: node.startPosition.row + 1, exported: isExported(node) });
        }
        break;
      }
      case "class_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          symbols.push({ name, kind: "class", line: node.startPosition.row + 1, exported: isExported(node) });
          const body = node.childForFieldName("body");
          if (body) {
            for (const child of children(body)) {
              if (child.type === "method_definition" || child.type === "public_field_definition") {
                const methodName = child.childForFieldName("name")?.text;
                if (methodName) {
                  symbols.push({ name: methodName, kind: "method", line: child.startPosition.row + 1, exported: false });
                }
              }
            }
          }
        }
        break;
      }
      case "interface_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          symbols.push({ name, kind: "interface", line: node.startPosition.row + 1, exported: isExported(node) });
        }
        break;
      }
      case "type_alias_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          symbols.push({ name, kind: "type", line: node.startPosition.row + 1, exported: isExported(node) });
        }
        break;
      }
      case "enum_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          symbols.push({ name, kind: "enum", line: node.startPosition.row + 1, exported: isExported(node) });
        }
        break;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        const exported = isExported(node);
        for (const declarator of children(node)) {
          if (declarator.type === "variable_declarator") {
            const nameNode = declarator.childForFieldName("name");
            const value = declarator.childForFieldName("value");
            if (nameNode) {
              const isArrow = value?.type === "arrow_function";
              const isFunc = value?.type === "function_expression" || value?.type === "function";
              if (isArrow || isFunc) {
                symbols.push({ name: nameNode.text, kind: "function", line: node.startPosition.row + 1, exported });
              } else {
                const firstChild = nonNullChildren(node)[0];
                const isConst = node.type === "lexical_declaration" && firstChild?.text === "const";
                symbols.push({
                  name: nameNode.text,
                  kind: isConst ? "const" : "variable",
                  line: node.startPosition.row + 1,
                  exported,
                });
              }
            }
          }
        }
        break;
      }
      case "export_statement": {
        for (const child of children(node)) {
          walk(child);
        }
        return;
      }
    }

    if (node.type === "program") {
      for (const child of children(node)) {
        walk(child);
      }
    }
  }

  walk(root);
  return symbols;
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function extractPythonSymbols(root: Node): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function walkTopLevel(nodes: Node[]): void {
    for (const child of nodes) {
      switch (child.type) {
        case "function_definition": {
          const name = child.childForFieldName("name")?.text;
          if (name && !name.startsWith("_")) {
            symbols.push({ name, kind: "function", line: child.startPosition.row + 1, exported: true });
          }
          break;
        }
        case "class_definition": {
          const name = child.childForFieldName("name")?.text;
          if (name) {
            symbols.push({ name, kind: "class", line: child.startPosition.row + 1, exported: !name.startsWith("_") });
            const body = child.childForFieldName("body");
            if (body) {
              for (const member of children(body)) {
                if (member.type === "function_definition") {
                  const methodName = member.childForFieldName("name")?.text;
                  if (methodName && !methodName.startsWith("_")) {
                    symbols.push({ name: methodName, kind: "method", line: member.startPosition.row + 1, exported: false });
                  }
                }
              }
            }
          }
          break;
        }
        case "decorated_definition": {
          const innerNodes = children(child).filter(
            (inner) => inner.type === "function_definition" || inner.type === "class_definition",
          );
          walkTopLevel(innerNodes);
          break;
        }
      }
    }
  }

  walkTopLevel(children(root));
  return symbols;
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

function isGoExported(name: string): boolean {
  return name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
}

function extractGoSymbols(root: Node): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  for (const child of children(root)) {
    switch (child.type) {
      case "function_declaration": {
        const name = child.childForFieldName("name")?.text;
        if (name) {
          symbols.push({ name, kind: "function", line: child.startPosition.row + 1, exported: isGoExported(name) });
        }
        break;
      }
      case "method_declaration": {
        const name = child.childForFieldName("name")?.text;
        if (name) {
          symbols.push({ name, kind: "method", line: child.startPosition.row + 1, exported: isGoExported(name) });
        }
        break;
      }
      case "type_declaration": {
        for (const spec of children(child)) {
          if (spec.type === "type_spec") {
            const name = spec.childForFieldName("name")?.text;
            const typeNode = spec.childForFieldName("type");
            if (name) {
              let kind: CodeSymbol["kind"] = "type";
              if (typeNode?.type === "struct_type") kind = "struct";
              else if (typeNode?.type === "interface_type") kind = "interface";
              symbols.push({ name, kind, line: spec.startPosition.row + 1, exported: isGoExported(name) });
            }
          }
        }
        break;
      }
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

function isRustPub(node: Node): boolean {
  return nonNullChildren(node).some((child) => child.type === "visibility_modifier");
}

function extractRustSymbols(root: Node): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  for (const child of children(root)) {
    switch (child.type) {
      case "function_item": {
        const name = child.childForFieldName("name")?.text;
        if (name) {
          symbols.push({ name, kind: "function", line: child.startPosition.row + 1, exported: isRustPub(child) });
        }
        break;
      }
      case "struct_item": {
        const name = child.childForFieldName("name")?.text;
        if (name) {
          symbols.push({ name, kind: "struct", line: child.startPosition.row + 1, exported: isRustPub(child) });
        }
        break;
      }
      case "enum_item": {
        const name = child.childForFieldName("name")?.text;
        if (name) {
          symbols.push({ name, kind: "enum", line: child.startPosition.row + 1, exported: isRustPub(child) });
        }
        break;
      }
      case "trait_item": {
        const name = child.childForFieldName("name")?.text;
        if (name) {
          symbols.push({ name, kind: "trait", line: child.startPosition.row + 1, exported: isRustPub(child) });
        }
        break;
      }
      case "impl_item": {
        const body = child.childForFieldName("body");
        if (body) {
          for (const member of children(body)) {
            if (member.type === "function_item") {
              const name = member.childForFieldName("name")?.text;
              if (name) {
                symbols.push({ name, kind: "method", line: member.startPosition.row + 1, exported: isRustPub(member) });
              }
            }
          }
        }
        break;
      }
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const EXTRACTORS: Record<string, (root: Node) => CodeSymbol[]> = {
  typescript: extractTSSymbols,
  tsx: extractTSSymbols,
  javascript: extractTSSymbols,
  python: extractPythonSymbols,
  go: extractGoSymbols,
  rust: extractRustSymbols,
};

/**
 * Extract code symbols from a parsed syntax tree.
 * Returns an empty array if the language has no extractor.
 */
export function extractSymbols(root: Node, langName: string): CodeSymbol[] {
  const extractor = EXTRACTORS[langName];
  if (!extractor) return [];
  return extractor(root);
}
