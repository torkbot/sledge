import { Type, type Static } from "typebox";

export const ArtifactRefSchema = Type.String({
  minLength: 1,
  pattern: "^artifact:[a-z-]+:[^:]+$",
});

export const MemoryEntrySchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  value: Type.String({ minLength: 1 }),
});

export const MemoryArtifactSchema = Type.Object({
  entries: Type.Array(MemoryEntrySchema),
});

export const ConversationMessageSchema = Type.Union([
  Type.Object({
    cursor: Type.Integer({ minimum: 1 }),
    id: Type.String({ minLength: 1 }),
    kind: Type.Literal("durable"),
    memory: MemoryEntrySchema,
    text: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    cursor: Type.Integer({ minimum: 1 }),
    id: Type.String({ minLength: 1 }),
    kind: Type.Literal("transient"),
    text: Type.String({ minLength: 1 }),
  }),
]);

export const PrefixArtifactSchema = Type.Object({
  messages: Type.Array(ConversationMessageSchema),
});

export const DreamInputSchema = Type.Object({
  attemptId: Type.String({ minLength: 1 }),
  conversationId: Type.String({ minLength: 1 }),
  parentEpoch: Type.Integer({ minimum: 0 }),
  cutoff: Type.Integer({ minimum: 1 }),
  previousMemoryRef: ArtifactRefSchema,
  rawPrefixRef: ArtifactRefSchema,
});

export const DreamOutputSchema = Type.Object({
  attemptId: Type.String({ minLength: 1 }),
  conversationId: Type.String({ minLength: 1 }),
  parentEpoch: Type.Integer({ minimum: 0 }),
  cutoff: Type.Integer({ minimum: 1 }),
  memoryRef: ArtifactRefSchema,
  rawPrefixRef: ArtifactRefSchema,
});

export const CompactionOutputSchema = Type.Object({
  attemptId: Type.String({ minLength: 1 }),
  conversationId: Type.String({ minLength: 1 }),
  parentEpoch: Type.Integer({ minimum: 0 }),
  cutoff: Type.Integer({ minimum: 1 }),
  memoryRef: ArtifactRefSchema,
  compactedPrefixRef: ArtifactRefSchema,
});

export const PublishedEpochSchema = Type.Object({
  conversationId: Type.String({ minLength: 1 }),
  epoch: Type.Integer({ minimum: 1 }),
  parentEpoch: Type.Integer({ minimum: 0 }),
  cutoff: Type.Integer({ minimum: 1 }),
  memoryRef: ArtifactRefSchema,
  compactedPrefixRef: ArtifactRefSchema,
});

export type MemoryArtifact = Static<typeof MemoryArtifactSchema>;
export type PrefixArtifact = Static<typeof PrefixArtifactSchema>;
export type PublishedEpoch = Static<typeof PublishedEpochSchema>;
