import { createGatewayEngine, type GatewayEngineOptions } from "./engine"
import { checkExtensionPrograms, checkExtensionSchema, extensionSchema, extensionSql } from "./extension-sql"
import { singleExtensionStatement } from "./extension-statement"
import { createGatewayRelay, type GatewayRelayOptions } from "./relay"
import * as ops from "./store-ops"
import * as relay from "./store-relay-ops"
import type { StoreExtensionTransaction } from "./store-extensions"

export function extensionTransaction(ctx: ops.StoreContext, name: string, now: number) {
  let active = true
  let failure: unknown
  let tail = Promise.resolve()
  const checkActive = (): void => {
    if (!active) throw new Error("The extension transaction has ended.")
    if (failure !== undefined) throw failure
  }
  function schedule<T>(body: () => Promise<T>): Promise<T> {
    checkActive()
    const next = tail.then(body)
    tail = next.then(() => undefined, (error: unknown) => { failure = error })
    return next
  }
  function sql<T>(statement: string, body: () => T): T {
    checkActive()
    const before = extensionSchema(ctx.sql)
    try {
      singleExtensionStatement(statement)
      const value = extensionSql(ctx.sql, name, body)
      checkExtensionSchema(name, before, extensionSchema(ctx.sql))
      checkExtensionPrograms(ctx.sql, name)
      return value
    } catch (error) {
      failure = error
      throw error
    }
  }
  const store: GatewayRelayOptions["store"] & GatewayEngineOptions["store"] = {
    now: () => now,
    busyTimeoutMs: ctx.config.busy_timeout_ms,
    enqueue: (request) => ops.enqueue(ctx, request),
    completeReceipt: (request) => ops.completeReceipt(ctx, request),
    abandonReceipt: (request) => ops.abandonReceipt(ctx, request),
    deliveryView: async (id) => ops.deliveryView(ctx, id),
    bind: (request) => relay.bindThread(ctx, request),
    unbind: (request) => relay.unbindThread(ctx, request),
    rebind: (request) => relay.rebindThread(ctx, request),
    listBindings: (request) => relay.listBindings(ctx, request),
    bindingView: (request) => relay.bindingView(ctx, request),
    report: (request) => relay.reportEvent(ctx, request),
    readOutbox: (request) => relay.readOutbox(ctx, { ...request, pendingOnly: true }),
    ackOutbox: (request) => relay.ackOutbox(ctx, request),
    claimAnswer: (request) => relay.claimAnswer(ctx, request),
    releaseAnswer: (request) => relay.releaseAnswer(ctx, request),
    confirmAnswer: (request) => relay.confirmAnswer(ctx, request),
    markPriorDelivered: (request) => relay.markPriorDelivered(ctx, request),
    emitCompletions: (request) => relay.emitCompletions(ctx, request),
  }
  // This is enqueue-only: no endpoint is resolved or contacted while the transaction is open.
  // The committed inbox marker wakes the receiver, using the existing offline delivery path.
  const endpoints = { wake: async (): Promise<never> => { throw new Error("An extension enqueue cannot contact a live endpoint.") } }
  const engine = createGatewayEngine({
    store,
    endpoints,
    resolve: async (durable_id) => ({ kind: "ok", target: { durable_id, endpoint: null, liveness: "dead" } }),
  })
  const api = createGatewayRelay({ store, engine, endpoints, locate: async () => null })
  const tx: StoreExtensionTransaction = {
    all: (columns, statement, params, orderBy) => sql(statement, () => {
      for (const column of columns) singleExtensionStatement(column)
      if (orderBy !== undefined) singleExtensionStatement(orderBy)
      return ctx.sql.all(columns, statement, params, orderBy)
    }),
    one: (columns, statement, params) => sql(statement, () => {
      for (const column of columns) singleExtensionStatement(column)
      return ctx.sql.one(columns, statement, params)
    }),
    exec: (statement, params) => sql(statement, () => ctx.sql.run(statement, params)),
    enqueue: (request) => schedule(() => api.inbound(request)),
    outboxAck: (request) => schedule(() => api.ack(request)),
    bind: (request) => schedule(() => api.bind(request)),
    unbind: (request) => schedule(() => api.unbind(request)),
    rebind: (request) => schedule(() => api.rebind(request)),
    bindingFor: (request) => schedule(() => relay.bindingFor(ctx, { ...request, now })),
    outboxPending: (request) => schedule(() => api.outbox(request)),
  }
  return {
    tx,
    finish: async () => {
      active = false
      await tail
      api.dispose()
      if (failure !== undefined) throw failure
    },
  }
}
