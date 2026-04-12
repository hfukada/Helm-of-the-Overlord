import type { Node } from "web-tree-sitter";

type SyntaxNode = Node;

const MIN_IDENTIFIER_LENGTH = 3;

/**
 * Extract all unique identifier references from a syntax tree.
 * Filters out short identifiers (length <= 2) to reduce noise.
 */
export function extractReferences(root: SyntaxNode): Set<string> {
  const refs = new Set<string>();

  function walk(node: SyntaxNode): void {
    if (node.type === "identifier" || node.type === "type_identifier" || node.type === "property_identifier") {
      const text = node.text;
      if (text.length >= MIN_IDENTIFIER_LENGTH) {
        refs.add(text);
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  }

  walk(root);
  return refs;
}
