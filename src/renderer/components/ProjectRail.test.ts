import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ProjectRecord, RuntimeStatus } from '../../shared/contracts';
import { ProjectRail, projectContextMenuPosition } from './ProjectRail';

describe('ProjectRail context menu', () => {
  it('keeps the rename action inside the visible window', () => {
    expect(projectContextMenuPosition(1_000, 700, 1_024, 720)).toEqual({ x: 802, y: 566 });
    expect(projectContextMenuPosition(-20, -10, 1_024, 720)).toEqual({ x: 8, y: 8 });
  });

  it('renders the dashboard rail in its compact form with an expand control', () => {
    const markup = renderToStaticMarkup(createElement(ProjectRail, {
      projects: [],
      runtime: { state: 'ready' } as RuntimeStatus,
      open: false,
      collapsed: true,
      variant: 'dashboard',
      onOpen: () => undefined,
      onClose: () => undefined,
      onToggleCollapse: () => undefined,
      onHome: () => undefined,
      onSelect: () => undefined,
      onCreate: () => undefined,
      onRename: () => undefined,
      onTogglePinned: () => undefined,
      onDelete: () => undefined,
      onSettings: () => undefined,
    }));

    expect(markup).toContain('mode-dashboard is-collapsed');
    expect(markup).toContain('class="brand" type="button" aria-label="展开首页侧栏"');
    expect(markup).not.toContain('class="rail-collapse"');
    expect(markup).toContain('brand-monogram');
    expect(markup).toContain('class="compact-create" type="button" title="首页"');
    expect(markup).toContain('lucide-house');
    expect(markup).not.toContain('lucide-plus');
  });

  it('counts imported games and gives them the same project controls', () => {
    const projects = [
      { id: 'pelican-astra', name: '鹈鹕骑车 · 海岸漫游', engine: 'web', status: 'completed', updatedAt: '2026-10-10T00:00:00.000Z' },
      { id: 'pelican-opus', name: '鹈鹕骑车 · 追风骑行', engine: 'web', status: 'completed', updatedAt: '2026-10-10T00:00:00.000Z' },
    ] as ProjectRecord[];
    const markup = renderToStaticMarkup(createElement(ProjectRail, {
      projects,
      selectedId: projects[0]!.id,
      runtime: { state: 'ready' } as RuntimeStatus,
      open: true,
      collapsed: false,
      variant: 'workbench',
      onOpen: () => undefined,
      onClose: () => undefined,
      onToggleCollapse: () => undefined,
      onHome: () => undefined,
      onSelect: () => undefined,
      onCreate: () => undefined,
      onRename: () => undefined,
      onTogglePinned: () => undefined,
      onDelete: () => undefined,
      onSettings: () => undefined,
    }));

    expect(markup).toContain('<span>MY GAMES</span><strong>02</strong>');
    for (const project of projects) {
      expect(markup).toContain(`打开“${project.name}”的项目菜单`);
      expect(markup).toContain(`aria-label="打开 ${project.name}"`);
    }
    expect(markup).toContain('project-item-row is-active');
  });

  it('keeps an expand control when the workbench rail is collapsed', () => {
    const markup = renderToStaticMarkup(createElement(ProjectRail, {
      projects: [],
      runtime: { state: 'ready' } as RuntimeStatus,
      open: false,
      collapsed: false,
      variant: 'workbench',
      onOpen: () => undefined,
      onClose: () => undefined,
      onToggleCollapse: () => undefined,
      onHome: () => undefined,
      onSelect: () => undefined,
      onCreate: () => undefined,
      onRename: () => undefined,
      onTogglePinned: () => undefined,
      onDelete: () => undefined,
      onSettings: () => undefined,
    }));

    expect(markup).toContain('class="brand compact-brand-toggle"');
    expect(markup).toContain('aria-label="打开项目列表"');
  });
});
