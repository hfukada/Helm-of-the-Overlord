import type { BlueprintNode, BlueprintNodeType, BlueprintState } from "../shared/types";

const NODES: BlueprintNode[] = [
  {
    name: "index",
    type: "deterministic",
    transitions: { done: "plan", error: "plan" },
  },
  {
    name: "plan",
    type: "agentic",
    transitions: { done: "implement", error: "review" },
  },
  {
    name: "implement",
    type: "agentic",
    transitions: { done: "lint", error: "review" },
  },
  {
    name: "lint",
    type: "deterministic",
    transitions: { clean: "ci", errors: "fix_lint" },
  },
  {
    name: "fix_lint",
    type: "agentic",
    transitions: { done: "lint", error: "review" },
  },
  {
    name: "ci",
    type: "deterministic",
    transitions: { pass: "review", fail: "fix_ci" },
  },
  {
    name: "fix_ci",
    type: "agentic",
    transitions: { done: "ci", error: "review" },
  },
  {
    name: "review",
    type: "human",
    transitions: {
      accept: "commit",
      revise: "implement",
      cancel: "review",
    },
  },
  {
    name: "commit",
    type: "deterministic",
    transitions: {},
  },
];

export function getNode(name: BlueprintNodeType): BlueprintNode | undefined {
  return NODES.find((n) => n.name === name);
}

export function getNextNode(
  currentName: BlueprintNodeType,
  result: string
): BlueprintNodeType | null {
  const node = getNode(currentName);
  if (!node) return null;
  return node.transitions[result] ?? null;
}

export function createInitialState(): BlueprintState {
  return {
    current_node: "index",
    history: [],
    ci_rounds: 0,
    lint_rounds: 0,
  };
}

export function advanceState(
  state: BlueprintState,
  result: string
): BlueprintState {
  const now = new Date().toISOString();
  const nextNode = getNextNode(state.current_node, result);

  if (!nextNode) {
    return state;
  }

  // Close current history entry
  const history = state.history.map((h) => {
    if (h.node === state.current_node && !h.exited_at) {
      return { ...h, exited_at: now, result };
    }
    return h;
  });

  // Add new entry
  history.push({
    node: nextNode,
    entered_at: now,
    exited_at: null,
    result: null,
  });

  return {
    ...state,
    current_node: nextNode,
    history,
  };
}
