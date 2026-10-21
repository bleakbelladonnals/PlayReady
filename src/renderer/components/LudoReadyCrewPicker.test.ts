import { describe, expect, it } from 'vitest';

import type { LudoReadyCrewMember } from '../../shared/contracts';
import {
  assignLudoReadyCrewRole,
  toggleLudoReadyCrewMember,
} from './LudoReadyCrewPicker';

const baseCrew: readonly LudoReadyCrewMember[] = [
  { packId: 'classic', role: 'planner' },
  { packId: 'twilight', role: 'artist' },
  { packId: 'hellokitty', role: 'engineer' },
];

describe('LudoReadyCrewPicker helpers', () => {
  it('adds a unique pack in the first unfilled role', () => {
    expect(toggleLudoReadyCrewMember(baseCrew, 'mosslight')).toEqual([
      ...baseCrew,
      { packId: 'mosslight', role: 'tester' },
    ]);
  });

  it('enforces the two-to-four member limits', () => {
    const minimum = baseCrew.slice(0, 2);
    expect(toggleLudoReadyCrewMember(minimum, 'classic')).toEqual(minimum);

    const maximum = toggleLudoReadyCrewMember(baseCrew, 'mosslight');
    expect(toggleLudoReadyCrewMember(maximum, 'starforge')).toEqual(maximum);
  });

  it('removes a selected member when the crew remains valid', () => {
    expect(toggleLudoReadyCrewMember(baseCrew, 'twilight')).toEqual([
      { packId: 'classic', role: 'planner' },
      { packId: 'hellokitty', role: 'engineer' },
    ]);
  });

  it('swaps occupied roles instead of producing duplicate assignments', () => {
    expect(assignLudoReadyCrewRole(baseCrew, 'hellokitty', 'planner')).toEqual([
      { packId: 'classic', role: 'engineer' },
      { packId: 'twilight', role: 'artist' },
      { packId: 'hellokitty', role: 'planner' },
    ]);
  });
});
