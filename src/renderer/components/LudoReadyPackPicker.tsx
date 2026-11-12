import { Check, ChevronDown, Sparkles } from 'lucide-react';
import React, { type KeyboardEvent } from 'react';

import type { LudoReadyPackId } from '../../shared/contracts';
import classicAvatar from '../assets/ludoready-packs/classic/frames/sprite-idle-a.png';
import classicScene from '../assets/ludoready-packs/classic/scene.png';
import helloKittyAvatar from '../assets/ludoready-packs/hellokitty/frames/sprite-idle-a.png';
import helloKittyScene from '../assets/ludoready-packs/hellokitty/scene.png';
import mosslightAvatar from '../assets/ludoready-packs/mosslight/frames/sprite-idle-a.png';
import mosslightScene from '../assets/ludoready-packs/mosslight/scene.png';
import starforgeAvatar from '../assets/ludoready-packs/starforge/frames/sprite-idle-a.png';
import starforgeScene from '../assets/ludoready-packs/starforge/scene.png';
import twilightAvatar from '../assets/ludoready-packs/twilight/frames/sprite-idle-a.png';
import twilightScene from '../assets/ludoready-packs/twilight/scene.png';

export interface LudoReadyPackOption {
  id: LudoReadyPackId;
  name: string;
  eyebrow: string;
  description: string;
  avatarLabel: string;
  avatarDescription: string;
  sceneDescription: string;
  sceneImage: string;
  avatarImage: string;
}

export const LUDOREADY_PACK_OPTIONS: readonly LudoReadyPackOption[] = [
  {
    id: 'classic',
    name: '经典工坊',
    eyebrow: 'CLASSIC STUDIO',
    description: '暖木工作室与原版 PlayReady，适合大多数游戏制作任务。',
    avatarLabel: '经典制作人',
    avatarDescription: '热情、可靠的全能制作伙伴，适合陪你完成第一款游戏。',
    sceneDescription: '暖木色像素工作室，包含需求桌、装配台与试玩区。',
    sceneImage: classicScene,
    avatarImage: classicAvatar,
  },
  {
    id: 'mosslight',
    name: '苔光工坊',
    eyebrow: 'MOSSLIGHT ATELIER',
    description: '植物、琥珀灯与游侠 PlayReady，适合自然和冒险题材。',
    avatarLabel: '苔光游侠',
    avatarDescription: '安静敏锐的自然系伙伴，擅长探索、地图与冒险题材。',
    sceneDescription: '被植物与琥珀灯包围的苔光工作室，气氛安静而专注。',
    sceneImage: mosslightScene,
    avatarImage: mosslightAvatar,
  },
  {
    id: 'starforge',
    name: '星铸工坊',
    eyebrow: 'STARFORGE LAB',
    description: '星舰机械间与工程师 PlayReady，适合科幻和 3D 项目。',
    avatarLabel: '星铸工程师',
    avatarDescription: '喜欢机械与调试的工程伙伴，适合科幻、系统和 3D 项目。',
    sceneDescription: '蓝色晶体与机械终端构成的星铸实验室，科技感更强。',
    sceneImage: starforgeScene,
    avatarImage: starforgeAvatar,
  },
  {
    id: 'twilight',
    name: '暮光魔法工坊',
    eyebrow: 'TWILIGHT MAGIC LAB',
    description: '小马宝莉·暮光闪闪与魔法研究室，适合解谜、叙事和奇幻冒险。',
    avatarLabel: '小马宝莉·暮光闪闪',
    avatarDescription: '专注研究与魔法推演的伙伴，适合解谜、叙事和奇幻冒险。',
    sceneDescription: '紫色魔法研究室与星光装置，为奇幻制作提供安静舞台。',
    sceneImage: twilightScene,
    avatarImage: twilightAvatar,
  },
  {
    id: 'hellokitty',
    name: 'Hello Kitty 工坊',
    eyebrow: 'HELLO KITTY STUDIO',
    description: 'Hello Kitty 与草莓创意室，适合休闲、装扮和温馨题材。',
    avatarLabel: 'Hello Kitty',
    avatarDescription: '温柔细致的创意伙伴，适合休闲、装扮与治愈题材。',
    sceneDescription: '明亮的草莓创意室，适合轻松、可爱和生活化的项目。',
    sceneImage: helloKittyScene,
    avatarImage: helloKittyAvatar,
  },
] as const;

export function ludoreadyPackGridColumnCount(container: HTMLElement | null): number {
  if (!container) return 1;
  const tracks = getComputedStyle(container).gridTemplateColumns
    .split(/\s+/)
    .filter((track) => track && track !== 'none');
  return Math.max(1, tracks.length);
}

export function ludoreadyPackLabel(id: LudoReadyPackId): string {
  return LUDOREADY_PACK_OPTIONS.find((option) => option.id === id)?.name ?? '经典工坊';
}

interface LudoReadyPackPickerProps {
  value: LudoReadyPackId | null;
  globalValue?: LudoReadyPackId;
  mode: 'global' | 'project';
  variant?: 'cards' | 'compact';
  presentation?: 'bundle' | 'character';
  disabled?: boolean;
  busy?: boolean;
  onChange: (value: LudoReadyPackId | null) => void;
}

export function LudoReadyPackPicker({
  value,
  globalValue = 'classic',
  mode,
  variant = 'cards',
  presentation = 'bundle',
  disabled = false,
  busy = false,
  onChange,
}: LudoReadyPackPickerProps) {
  const resolvedValue = value ?? globalValue;
  const resolvedOption = LUDOREADY_PACK_OPTIONS.find((option) => option.id === resolvedValue)
    ?? LUDOREADY_PACK_OPTIONS[0];

  if (variant === 'compact') {
    return (
      <label
        className={`ludoready-pack-compact is-${resolvedValue}${value === null ? ' is-inherited' : ''}`}
        title={disabled ? 'Agent 运行期间不能切换制作场景' : '选择这个项目的 PlayReady 形象与制作场景'}
      >
        <span
          className="ludoready-pack-compact-swatch"
          aria-hidden="true"
          style={{ backgroundImage: `url(${resolvedOption.sceneImage})` }}
        >
          <img src={resolvedOption.avatarImage} alt="" draggable={false} />
        </span>
        <span className="ludoready-pack-compact-copy" aria-hidden="true">
          <small>{mode === 'global' ? '默认场景' : value === null ? '跟随全局' : '项目场景'}</small>
          <strong>{busy ? '保存中…' : ludoreadyPackLabel(resolvedValue)}</strong>
        </span>
        <select
          aria-label="项目 PlayReady 形象与制作场景"
          value={value ?? 'inherit'}
          disabled={disabled || busy}
          onChange={(event) => {
            const nextValue = event.target.value;
            onChange(nextValue === 'inherit' ? null : nextValue as LudoReadyPackId);
          }}
        >
          {mode === 'project' ? (
            <option value="inherit">跟随全局（当前：{ludoreadyPackLabel(globalValue)}）</option>
          ) : null}
          {LUDOREADY_PACK_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.name} · {option.avatarLabel}</option>
          ))}
        </select>
        <ChevronDown size={12} aria-hidden="true" />
      </label>
    );
  }

  const options: Array<LudoReadyPackOption & { inherited?: boolean }> = mode === 'project'
    ? [{
        ...LUDOREADY_PACK_OPTIONS.find((option) => option.id === globalValue)!,
        id: globalValue,
        name: `跟随全局 · ${ludoreadyPackLabel(globalValue)}`,
        eyebrow: 'FOLLOW GLOBAL',
        description: '项目会自动使用设置中的全局默认主题包。',
        inherited: true,
      }, ...LUDOREADY_PACK_OPTIONS]
    : [...LUDOREADY_PACK_OPTIONS];

  function selectAt(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.inherited ? null : option.id);
  }

  function handleArrowKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    const columnCount = ludoreadyPackGridColumnCount(container);
    let nextIndex = index;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = options.length - 1;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + options.length) % options.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % options.length;
    if (event.key === 'ArrowUp') nextIndex = Math.max(0, index - columnCount);
    if (event.key === 'ArrowDown') nextIndex = Math.min(options.length - 1, index + columnCount);
    const nextButton = container?.querySelector<HTMLButtonElement>(`button[data-pack-index="${nextIndex}"]`);
    nextButton?.focus();
    selectAt(nextIndex);
  }

  return (
    <div
      className={`ludoready-pack-picker mode-${mode} presentation-${presentation}`}
      role="radiogroup"
      aria-label={presentation === 'character'
        ? '选择默认 PlayReady 角色'
        : mode === 'global' ? '默认 PlayReady 形象与制作场景' : '项目 PlayReady 形象与制作场景'}
      aria-busy={busy}
    >
      {options.map((option, index) => {
        const selected = option.inherited ? value === null : value === option.id;
        return (
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={presentation === 'character'
              ? `${option.avatarLabel}：${option.avatarDescription}`
              : `${option.name}：${option.description}`}
            data-pack-kind={presentation}
            data-pack-index={index}
            className={`ludoready-pack-card pack-${option.id}${selected ? ' is-selected' : ''}${option.inherited ? ' is-inherited' : ''}`}
            key={option.inherited ? 'inherit' : option.id}
            disabled={disabled || busy}
            tabIndex={selected || (!options.some((item) => item.inherited ? value === null : value === item.id) && index === 0) ? 0 : -1}
            onKeyDown={(event) => handleArrowKey(event, index)}
            onClick={() => selectAt(index)}
          >
            <span
              className={`ludoready-pack-preview${presentation === 'character' ? ' ludoready-character-preview' : ''}`}
              aria-hidden="true"
            >
              {presentation === 'bundle' ? (
                <img
                  className="ludoready-pack-scene-image"
                  src={option.sceneImage}
                  alt=""
                  draggable={false}
                />
              ) : <span className="ludoready-character-pixel-grid" />}
              <img
                className={`ludoready-pack-avatar-image${presentation === 'character' ? ' ludoready-character-avatar-image' : ''}`}
                src={option.avatarImage}
                alt=""
                draggable={false}
              />
              {option.inherited ? <Sparkles className="ludoready-pack-follow-icon" size={17} /> : null}
            </span>
            <span className="ludoready-pack-card-copy">
              <small>{presentation === 'character' ? 'PLAYREADY CHARACTER' : option.eyebrow}</small>
              <strong>{presentation === 'character' ? option.avatarLabel : option.name}</strong>
              <span>{presentation === 'character' ? option.avatarDescription : option.description}</span>
            </span>
            <span className="ludoready-pack-check" aria-hidden="true"><Check size={13} /></span>
          </button>
        );
      })}
    </div>
  );
}
