import type { PublicTest } from '../tests/tests.service.js';
import type { ScoringConfig, ScoringMethod } from '../tests/scoring-config.js';
import type { AttachmentRow } from '../tests/tests.repo.js';

/** Pièce jointe figée dans l'instantané (avec son chemin de stockage, relatif à DATA_DIR). */
export type SnapshotAttachment = {
  id: string;
  originalName: string;
  mime: string;
  size: number;
  sha256: string;
  pages: number | null;
  storagePath: string;
};

/** Copie du test au lancement d'une série : la série reste reproductible si le test change ensuite. */
export type TestSnapshot = {
  testId: string;
  name: string;
  category: string;
  tags: string[];
  systemPrompt: string | null;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  scoringMethod: ScoringMethod;
  scoringConfig: ScoringConfig;
  attachments: SnapshotAttachment[];
};

/**
 * Les pièces jointes viennent des lignes brutes (la vue publique n'expose pas `storagePath`) ;
 * seules les pièces non retirées (`deletedAt === null`) sont conservées.
 */
export function snapshotOf(test: Omit<PublicTest, 'attachments'>, attachments: AttachmentRow[]): TestSnapshot {
  return {
    testId: test.id,
    name: test.name,
    category: test.category,
    tags: [...test.tags],
    systemPrompt: test.systemPrompt,
    userPrompt: test.userPrompt,
    temperature: test.temperature,
    maxTokens: test.maxTokens,
    scoringMethod: test.scoringMethod,
    scoringConfig: structuredClone(test.scoringConfig),
    attachments: attachments
      .filter((a) => a.deletedAt === null)
      .map((a) => ({
        id: a.id,
        originalName: a.originalName,
        mime: a.mime,
        size: a.size,
        sha256: a.sha256,
        pages: a.pages,
        storagePath: a.storagePath,
      })),
  };
}
