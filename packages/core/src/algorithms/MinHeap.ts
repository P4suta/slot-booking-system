/**
 * Mutable binary min-heap — classic textbook implementation (ADR-0081
 * part 1). Heap key is read off each element via a caller-supplied
 * comparator, so the same data structure serves alarm deadlines
 * (priority = epoch ms), broadcast coalesce backlogs (priority =
 * insertion order), and reservation EDF queues (priority =
 * appointmentAt).
 *
 * Complexity:
 *   - {@link MinHeap.push}: O(log n)
 *   - {@link MinHeap.pop}: O(log n)
 *   - {@link MinHeap.peek}: O(1)
 *   - {@link MinHeap.size}: O(1)
 *   - {@link MinHeap.fromArray}: O(n) (Floyd build, not O(n log n))
 *
 * `compare(a, b)` returns a negative number when `a` should pop
 * before `b`, zero when they tie, positive when `b` pops first —
 * matches `Array.prototype.sort` and {@link Duration.compare}.
 */
export type Comparator<T> = (a: T, b: T) => number

export class MinHeap<T> {
  private readonly data: T[] = []
  private readonly compare: Comparator<T>

  constructor(compare: Comparator<T>) {
    this.compare = compare
  }

  static fromArray<T>(values: readonly T[], compare: Comparator<T>): MinHeap<T> {
    const heap = new MinHeap<T>(compare)
    heap.data.push(...values)
    // Floyd build: sift down from the last internal node.
    for (let i = (heap.data.length >> 1) - 1; i >= 0; i -= 1) {
      heap.siftDown(i)
    }
    return heap
  }

  size(): number {
    return this.data.length
  }

  isEmpty(): boolean {
    return this.data.length === 0
  }

  peek(): T | undefined {
    return this.data[0]
  }

  push(value: T): void {
    this.data.push(value)
    this.siftUp(this.data.length - 1)
  }

  pop(): T | undefined {
    const n = this.data.length
    if (n === 0) return undefined
    const top = this.data[0]
    const last = this.data.pop()
    if (n > 1 && last !== undefined) {
      this.data[0] = last
      this.siftDown(0)
    }
    return top
  }

  /** Snapshot of the underlying array, primarily for tests / debugging. */
  toArray(): readonly T[] {
    return this.data.slice()
  }

  private siftUp(start: number): void {
    let i = start
    while (i > 0) {
      const parent = (i - 1) >> 1
      const a = this.data[i] as T
      const b = this.data[parent] as T
      if (this.compare(a, b) >= 0) break
      this.data[i] = b
      this.data[parent] = a
      i = parent
    }
  }

  private siftDown(start: number): void {
    const n = this.data.length
    let i = start
    for (;;) {
      const left = 2 * i + 1
      const right = 2 * i + 2
      let smallest = i
      if (left < n && this.compare(this.data[left] as T, this.data[smallest] as T) < 0) {
        smallest = left
      }
      if (right < n && this.compare(this.data[right] as T, this.data[smallest] as T) < 0) {
        smallest = right
      }
      if (smallest === i) break
      const a = this.data[i] as T
      const b = this.data[smallest] as T
      this.data[i] = b
      this.data[smallest] = a
      i = smallest
    }
  }
}
