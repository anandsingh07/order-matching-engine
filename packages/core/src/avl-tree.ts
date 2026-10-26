interface AvlNode<V> {
  key: number;
  value: V;
  height: number;
  left: AvlNode<V> | null;
  right: AvlNode<V> | null;
}

const heightOf = (node: AvlNode<unknown> | null): number => (node === null ? 0 : node.height);

function updateHeight(node: AvlNode<unknown>): void {
  node.height = 1 + Math.max(heightOf(node.left), heightOf(node.right));
}

function rotateRight<V>(node: AvlNode<V>): AvlNode<V> {
  const pivot = node.left!;
  node.left = pivot.right;
  pivot.right = node;
  updateHeight(node);
  updateHeight(pivot);
  return pivot;
}

function rotateLeft<V>(node: AvlNode<V>): AvlNode<V> {
  const pivot = node.right!;
  node.right = pivot.left;
  pivot.left = node;
  updateHeight(node);
  updateHeight(pivot);
  return pivot;
}

function rebalance<V>(node: AvlNode<V>): AvlNode<V> {
  updateHeight(node);
  const balance = heightOf(node.left) - heightOf(node.right);
  if (balance > 1) {
    if (heightOf(node.left!.left) < heightOf(node.left!.right)) node.left = rotateLeft(node.left!);
    return rotateRight(node);
  }
  if (balance < -1) {
    if (heightOf(node.right!.right) < heightOf(node.right!.left)) node.right = rotateRight(node.right!);
    return rotateLeft(node);
  }
  return node;
}

/**
 * Self-balancing binary search tree keyed by number.
 * Insert, delete, lookup and min are O(log n); in-order iteration is O(n).
 * The comparator decides the order, so `min()` is "best price" for both
 * ascending (asks) and descending (bids) books.
 */
export class AvlTree<V> {
  private root: AvlNode<V> | null = null;
  private count = 0;

  constructor(private readonly compare: (a: number, b: number) => number) {}

  get size(): number {
    return this.count;
  }

  get height(): number {
    return heightOf(this.root);
  }

  get(key: number): V | undefined {
    let node = this.root;
    while (node !== null) {
      const c = this.compare(key, node.key);
      if (c === 0) return node.value;
      node = c < 0 ? node.left : node.right;
    }
    return undefined;
  }

  /** The first value in comparator order. */
  min(): V | undefined {
    let node = this.root;
    if (node === null) return undefined;
    while (node.left !== null) node = node.left;
    return node.value;
  }

  set(key: number, value: V): void {
    this.root = this.insertAt(this.root, key, value);
  }

  delete(key: number): boolean {
    const before = this.count;
    this.root = this.deleteAt(this.root, key);
    return this.count < before;
  }

  /** In-order values. The tree must not be modified while iterating. */
  *values(): IterableIterator<V> {
    const stack: AvlNode<V>[] = [];
    let node = this.root;
    while (node !== null || stack.length > 0) {
      while (node !== null) {
        stack.push(node);
        node = node.left;
      }
      const next = stack.pop()!;
      yield next.value;
      node = next.right;
    }
  }

  private insertAt(node: AvlNode<V> | null, key: number, value: V): AvlNode<V> {
    if (node === null) {
      this.count++;
      return { key, value, height: 1, left: null, right: null };
    }
    const c = this.compare(key, node.key);
    if (c === 0) {
      node.value = value;
      return node;
    }
    if (c < 0) node.left = this.insertAt(node.left, key, value);
    else node.right = this.insertAt(node.right, key, value);
    return rebalance(node);
  }

  private deleteAt(node: AvlNode<V> | null, key: number): AvlNode<V> | null {
    if (node === null) return null;
    const c = this.compare(key, node.key);
    if (c < 0) {
      node.left = this.deleteAt(node.left, key);
    } else if (c > 0) {
      node.right = this.deleteAt(node.right, key);
    } else {
      this.count--;
      if (node.left === null) return node.right;
      if (node.right === null) return node.left;
      // Two children: take the in-order successor's place.
      let successor = node.right;
      while (successor.left !== null) successor = successor.left;
      node.key = successor.key;
      node.value = successor.value;
      node.right = this.removeMin(node.right);
    }
    return rebalance(node);
  }

  private removeMin(node: AvlNode<V>): AvlNode<V> | null {
    if (node.left === null) return node.right;
    node.left = this.removeMin(node.left);
    return rebalance(node);
  }
}
