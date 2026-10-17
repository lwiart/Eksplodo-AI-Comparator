import type { RunStatus } from '../../api/runs';
import { RUN_STATUS_LABELS } from '../../lib/format';
import { Chip } from '../ui/Chip';

const STATUS_TONES = { queued: 'default', running: 'live', paused: 'default', completed: 'good', interrupted: 'bad' } as const;

export function RunStatusChip({ status }: { status: RunStatus }) {
  return <Chip tone={STATUS_TONES[status]}>{RUN_STATUS_LABELS[status]}</Chip>;
}
