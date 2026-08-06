# Sledge Vision

## Thesis

Sledge should make the semantic ledger module, rather than the event, queue,
query, indexer, or materialization, the normal unit of system design.

A module owns a meaningful durable capability. It encapsulates the ledger
machinery and invariants required to implement that capability, then reveals
the smallest interface needed to configure, compose, and use it. Large ledger
systems are built by connecting these interfaces. Sledge resolves that
composition into one efficient, coherent ledger model.

The intended shape is tall and narrow: substantial depth behind a small top
surface. A module earns its place when deleting it would force its hidden
complexity back into many callers.

## Layered Surface

Sledge's low-level ledger substrate is necessarily broad. Module implementers
need events, durable work, queries, indexers, materializations, migrations,
leases, and transactional actions to express real systems. Making that
substrate artificially small would trade away capability rather than create
depth.

The breadth belongs at the lowest layer:

| Layer                   | Intended user                  | Visible concepts                                                  |
| ----------------------- | ------------------------------ | ----------------------------------------------------------------- |
| Ledger substrate        | Module implementers            | Events, work, queries, indexers, materializations, and migrations |
| Deep modules            | Applications and other modules | Semantic capabilities, durable facts, and explicit requirements   |
| Application composition | Composition root               | Install, discover, connect, and reveal                            |

Most application code should interact with deep modules. Applications that
need unusual behavior may peel back a layer and author new modules directly on
the ledger substrate.

## Characteristics Of A Successful Module System

### Semantic Interfaces

A module's interface describes what it provides, not the mechanics used to
provide it. A compaction module might reveal the ability to request compaction,
observe its result, and read the current epoch. It should not ordinarily reveal
its control queue, intermediate projections, retry events, or indexers.

Narrow does not mean methods only. An event token is an excellent interface
when the durable fact itself is meaningful to consumers, such as an epoch being
published. An implementation detail does not become semantic merely because it
can be represented by a token.

Interface size is conceptual, not a method count. One method with a large
options bag, implicit ordering rules, and many undocumented states is still a
wide interface.

### Strong Ownership

A module owns the durable machinery that establishes its behavior:

- Durable facts, schemas, and identities
- Private work queues and scheduling policy
- Materializations and migrations
- Idempotency and coalescing rules
- Concurrency policy
- Failure and settlement semantics
- Internal orchestration and plumbing

Private machinery is unreachable unless the module deliberately reveals it.
Callers should not need raw storage access, private queue tokens, or knowledge
of internal table shapes to use or trust the module.

### Closed Composition

A composition of modules must itself be presentable as one module without
exposing its children.

A higher-level module may install and connect several smaller modules, then
reveal a narrower semantic capability. Its caller should not retain every child
handle, repeat their identifiers, or reconstruct their internal wiring at the
composition root.

Root complexity should grow with the number of application capabilities, not
with the number of events, queues, projections, or internal steps beneath them.

### Explicit Typed Edges

Modules compose by consuming capabilities deliberately revealed by other
modules. Those edges establish ownership and make requirements visible.
Correctness must not depend on importing an implementation detail, forging a
token, or remembering an undocumented installation order.

Composition creates semantic connections. It should not require callers to
manually reproduce the orchestration that a deeper module exists to own.

### Legible Phases

Definition, assembly, discovery, and opening are distinct phases with distinct
capabilities. Advancing between phases should return a new immutable value
rather than mutate an existing value through an activation method.

Assembly may use durable configuration or an installed registry to discover
additional modules. Every assembly query must settle, and the final installed
graph must be resolved and validated, before workers begin processing.

The baseline module system should be sufficient to build plugin discovery in
userspace. Sledge does not need a built-in concept of plugins.

### Local Durable Evolution

A module's durable contracts are part of its interface. Its implementation may
change freely while those contracts and their semantics remain valid.

Changes to durable identity, schemas, or topology require an explicit data
posture: additive compatibility, migration, versioned coexistence, or an
intentional reset. Existing data must never be silently reinterpreted by a new
implementation.

The resolved application must reject an incompatible ledger before dispatching
work. Evolution policy belongs with the module that owns the affected durable
facts, rather than being reconstructed at every caller.

### Efficient Flattening

Composition should disappear operationally. The resolved hierarchy becomes one
ledger model while preserving ownership, transactional behavior, and storage
locality.

Abstraction should not require:

- Generic wrapper events merely to connect modules
- Copies of values whose authoritative durable fact already exists
- A projection for every composition edge
- Replay or interpreter machinery for modules that do not require it
- Runtime layers proportional to the number of authoring abstractions

Ledger growth and execution cost should follow the durable meaning the
application needs, not the number of modules used to express it.

### Interface-Level Verification

A module should be testable through the same interface its callers use.
Black-box contracts should establish behavior across restart, concurrency,
failure, deterministic time, and supported storage adapters.

Tests may exercise private seams when diagnosing the implementation, but a
caller should not need to understand internal queues and projections to gain
confidence in the module's contract.

### Operational Legibility

The resolved system should make module identity, ownership, requirements, and
durable work attributable. Errors should name the responsible module and
contract. Operators should be able to understand which modules are installed
and why work is pending without reverse-engineering private storage.

Legibility must not require exposing private implementation capabilities to
application code.

## Composition Laws

The module system should preserve these properties:

1. A module owns every private contract it creates.
2. A module consumes another module only through an explicitly revealed
   capability.
3. A composite may hide its children and reveal a smaller interface.
4. Installing the same durable identity twice is invalid.
5. Given the same durable configuration and available definitions, assembly is
   deterministic.
6. The final graph is validated before storage mutation or work dispatch that
   depends on it.
7. Composition does not manufacture new durable facts unless those facts have
   application meaning.
8. Adding implementation depth does not enlarge the interface unless the module
   gains a genuinely new semantic capability.

## Reference Experiences

### Epoch Compaction

An epoch compaction module may internally combine memory extraction, prefix
compaction, background work, synchronous pressure handling, atomic publication,
projections, and recovery. Callers should see one capability concerned with
requesting and observing compaction epochs. The memory extractor and compactor
remain user-supplied implementations behind explicit seams.

Adding or replacing an internal step should not force every caller to learn the
new topology. Publishing an epoch must still make its compacted prefix and
memory version visible as one coherent durable outcome.

### Ledger-Defined Extension Discovery

An application may install a registry module, query its durable configuration
during assembly, and install the selected module definitions before opening the
final ledger. This can implement a plugin system without teaching Sledge what a
plugin is.

The application should interact with the capabilities revealed by the selected
modules. It should not need to collect their private ledger models and perform a
second manual composition step.

## Non-Goals

- One universal execution algebra for every durable module
- Hiding the ledger substrate from authors who need to create new modules
- Making every event, query, or result conform to one generic protocol
- Adding abstraction when a direct semantic event or query is already the
  deepest honest interface
- Preserving arbitrary topology changes against existing durable data without
  an explicit compatibility decision
- Baking application concepts such as plugins into the baseline ledger model

Portable result shapes and execution interpreters may be useful modules. They
must earn adoption through depth and composition leverage rather than becoming
mandatory substrate.

## Failure Signals

The design is moving away from this vision when:

- The composition root collects arrays of internal handles.
- Module identifiers or configuration keys are repeated outside their owner.
- Ordinary callers manipulate queues, indexers, or materialization tables.
- Adding an internal durable step forces changes across callers.
- Correctness depends on implicit installation order or ceremonial wiring.
- A module's interface grows in direct proportion to its implementation.
- A universal interpreter imposes replay and versioning semantics on modules
  that do not need them.
- Abstraction adds events, projections, or ledger growth without adding durable
  meaning.
- Existing databases can begin processing under an incompatible module graph.
- Tests must bypass the revealed interface to establish normal behavior.

## Standard Of Success

A reader should be able to understand a module's purpose, requirements,
invariants, failure modes, and performance characteristics from its interface
and black-box contract tests. They should not need to read its implementation
before using it correctly.

A large application should read as a composition of meaningful durable
capabilities. The events, work, projections, migrations, retries, and concurrency
that make those capabilities trustworthy should remain local to the modules
that own them.
