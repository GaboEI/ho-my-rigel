// Counting semaphore limiting concurrent search processes, a faithful port of
// `packages/omo-opencode/src/tools/shared/semaphore.ts`. The V1 tools cap
// ripgrep concurrency at two so parallel searches cannot saturate the CPU; the
// native port keeps that cap.
export class Semaphore {
  constructor(max) {
    this.max = max
    this.running = 0
    this.queue = []
  }

  async acquire() {
    if (this.running < this.max) {
      this.running += 1
      return
    }
    await new Promise((resolve) => {
      this.queue.push(() => {
        this.running += 1
        resolve()
      })
    })
  }

  release() {
    this.running -= 1
    const next = this.queue.shift()
    if (next) next()
  }
}

/** Global semaphore limiting concurrent ripgrep processes to 2, as in V1. */
export const rgSemaphore = new Semaphore(2)
