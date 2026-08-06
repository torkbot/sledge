# Durable execution graph prototype

This prototype asks whether a very small immutable execution graph can compile
to one private Sledge journal while preserving restart safety, data-dependent
`flatMap`, queue isolation, and typed dependency injection.

Run it with:

```sh
node --run prototype:execution
```

The example models the epoch operation that motivated the experiment:

1. call a user-supplied memory extractor;
2. durably journal its output;
3. pass that exact output to a user-supplied compactor;
4. expose the combined result through one portable `Settlement`.

The compactor deliberately throws on its first attempt. The runner closes the
ledger, reopens the same scratch database, and proves that memory extraction is
not repeated. It also prints every service attempt and the final settlement so
the durable transition is visible.

This is intentionally not a workflow operating system. It has one private
control queue and one private activity queue. Queue-local concurrency prevents
activities from consuming control capacity. The worker dispatcher keeps an
optional combined ceiling, while leaving fairness and additional executor
queues as later scheduling-policy work.
