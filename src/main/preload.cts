import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  AgentEvent,
  AppSettings,
  ApprovalAnswers,
  ApprovalDecision,
  ApprovalRequest,
  AssetPlanRecord,
  BootstrapPayload,
  CreateProjectInput,
  EnvironmentStatusSnapshot,
  FileReadResult,
  GameAssetRecord,
  GameplayExperienceReport,
  ExtensionSettingsSnapshot,
  LoginStartResult,
  McpServerSetting,
  MediaCapability,
  MediaProviderSetting,
  MediaProviderTestResult,
  LudoReadyCrewMember,
  LudoReadyPackId,
  LudoReadyApi,
  PromptTemplateId,
  PromptTemplateSetting,
  ProjectInspectorPayload,
  ProjectIconData,
  ProjectRecord,
  RunProjectInput,
  RuntimeStatus,
  SaveMcpServerInput,
  SaveMediaProviderInput,
  SkillSetting,
} from '../shared/contracts.js';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: LudoReadyApi = {
  bootstrap: () => ipcRenderer.invoke('ludoready:bootstrap') as Promise<BootstrapPayload>,
  refreshRuntime: () => ipcRenderer.invoke('ludoready:runtime:refresh') as Promise<RuntimeStatus>,
  startLogin: () => ipcRenderer.invoke('ludoready:runtime:login') as Promise<LoginStartResult>,
  logout: () => ipcRenderer.invoke('ludoready:runtime:logout') as Promise<RuntimeStatus>,
  chooseDirectory: () => ipcRenderer.invoke('ludoready:dialog:directory') as Promise<string | null>,
  chooseProjectDirectory: () =>
    ipcRenderer.invoke('ludoready:dialog:project-directory') as Promise<string | null>,
  createProject: (input: CreateProjectInput, files: readonly unknown[] = []) => {
    if (!Array.isArray(files) || files.length > 50) {
      return Promise.reject(new Error('一次最多上传 50 个附件'));
    }
    let paths: string[];
    try {
      paths = files.map((file) => webUtils.getPathForFile(file as File)).filter(Boolean);
    } catch {
      return Promise.reject(new Error('无法读取上传文件的本地路径'));
    }
    if (paths.length !== files.length) return Promise.reject(new Error('上传文件缺少本地路径'));
    return ipcRenderer.invoke('ludoready:project:create', input, paths) as Promise<ProjectRecord>;
  },
  renameProject: (projectId: string, name: string) =>
    ipcRenderer.invoke('ludoready:project:rename', projectId, name) as Promise<ProjectRecord>,
  setProjectPinned: (projectId: string, pinned: boolean) =>
    ipcRenderer.invoke('ludoready:project:pin', projectId, pinned) as Promise<ProjectRecord>,
  deleteProject: (projectId: string) =>
    ipcRenderer.invoke('ludoready:project:delete', projectId) as Promise<ProjectRecord>,
  runProject: (input: RunProjectInput) =>
    ipcRenderer.invoke('ludoready:project:run', input) as Promise<ProjectRecord>,
  stopProject: (projectId: string) =>
    ipcRenderer.invoke('ludoready:project:stop', projectId) as Promise<ProjectRecord>,
  revealProject: (projectId: string) =>
    ipcRenderer.invoke('ludoready:project:reveal', projectId) as Promise<ProjectRecord | null>,
  importProjectAssets: (projectId: string) =>
    ipcRenderer.invoke('ludoready:project:assets:import', projectId) as Promise<GameAssetRecord[]>,
  importDroppedProjectAssets: (projectId: string, files: readonly unknown[]) => {
    if (!Array.isArray(files) || files.length === 0 || files.length > 50) {
      return Promise.reject(new Error('一次只能拖入 1–50 张图片'));
    }
    let paths: string[];
    try {
      paths = files.map((file) => webUtils.getPathForFile(file as File)).filter(Boolean);
    } catch {
      return Promise.reject(new Error('无法读取拖入文件的本地路径'));
    }
    if (paths.length !== files.length) return Promise.reject(new Error('拖入文件缺少本地路径'));
    return ipcRenderer.invoke('ludoready:project:assets:import-paths', projectId, paths) as Promise<GameAssetRecord[]>;
  },
  retryAssetPlan: (projectId: string, planId: string) =>
    ipcRenderer.invoke('ludoready:project:asset-plan:retry', projectId, planId) as Promise<AssetPlanRecord>,
  inspectProject: (projectId: string) =>
    ipcRenderer.invoke('ludoready:project:inspect', projectId) as Promise<ProjectInspectorPayload>,
  evaluateProjectExperience: (projectId: string) =>
    ipcRenderer.invoke('ludoready:project:experience:evaluate', projectId) as Promise<GameplayExperienceReport>,
  cancelProjectExperience: (projectId: string) =>
    ipcRenderer.invoke('ludoready:project:experience:cancel', projectId) as Promise<void>,
  readProjectFile: (projectId: string, relativePath: string) =>
    ipcRenderer.invoke('ludoready:project:read', projectId, relativePath) as Promise<FileReadResult>,
  getProjectIcon: (projectId: string) =>
    ipcRenderer.invoke('ludoready:project:icon', projectId) as Promise<ProjectIconData | null>,
  saveProjectLudoReadyPack: (projectId: string, packId: LudoReadyPackId | null) =>
    ipcRenderer.invoke('ludoready:project:ludoready-pack:save', projectId, packId) as Promise<ProjectRecord>,
  saveProjectLudoReadyCrew: (projectId: string, crew: readonly LudoReadyCrewMember[] | null) =>
    ipcRenderer.invoke('ludoready:project:ludoready-crew:save', projectId, crew) as Promise<ProjectRecord>,
  saveSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke('ludoready:settings:save', patch) as Promise<AppSettings>,
  getEnvironmentStatus: () =>
    ipcRenderer.invoke('ludoready:environment:get') as Promise<EnvironmentStatusSnapshot>,
  refreshEnvironmentStatus: () =>
    ipcRenderer.invoke('ludoready:environment:refresh') as Promise<EnvironmentStatusSnapshot>,
  chooseGodotExecutable: () =>
    ipcRenderer.invoke('ludoready:environment:godot:choose') as Promise<string | null>,
  saveGodotExecutable: (binaryPath: string | null) =>
    ipcRenderer.invoke('ludoready:environment:godot:save', binaryPath) as Promise<EnvironmentStatusSnapshot>,
  getExtensionSettings: () =>
    ipcRenderer.invoke('ludoready:extensions:get') as Promise<ExtensionSettingsSnapshot>,
  saveMediaProvider: (input: SaveMediaProviderInput) =>
    ipcRenderer.invoke('ludoready:media-provider:save', input) as Promise<MediaProviderSetting>,
  testMediaProvider: (capability: MediaCapability) =>
    ipcRenderer.invoke('ludoready:media-provider:test', capability) as Promise<MediaProviderTestResult>,
  listSkills: () => ipcRenderer.invoke('ludoready:skills:list') as Promise<SkillSetting[]>,
  setSkillEnabled: (input: { id: string; enabled: boolean }) =>
    ipcRenderer.invoke('ludoready:skills:set-enabled', input) as Promise<SkillSetting>,
  listMcpServers: () => ipcRenderer.invoke('ludoready:mcp:list') as Promise<McpServerSetting[]>,
  saveMcpServer: (input: SaveMcpServerInput) =>
    ipcRenderer.invoke('ludoready:mcp:save', input) as Promise<McpServerSetting>,
  removeMcpServer: (id: string) => ipcRenderer.invoke('ludoready:mcp:remove', id) as Promise<void>,
  listPromptTemplates: () =>
    ipcRenderer.invoke('ludoready:prompts:list') as Promise<PromptTemplateSetting[]>,
  savePromptTemplate: (input: { id: PromptTemplateId; content: string; enabled: boolean }) =>
    ipcRenderer.invoke('ludoready:prompts:save', input) as Promise<PromptTemplateSetting>,
  resetPromptTemplate: (id: PromptTemplateId) =>
    ipcRenderer.invoke('ludoready:prompts:reset', id) as Promise<PromptTemplateSetting>,
  resolveApproval: (token: string, decision: ApprovalDecision, answers?: ApprovalAnswers) =>
    ipcRenderer.invoke('ludoready:approval:resolve', token, decision, answers) as Promise<void>,
  onAgentEvent: (listener: (event: AgentEvent) => void) =>
    subscribe('ludoready:event:agent', listener),
  onProjectChanged: (listener: (project: ProjectRecord) => void) =>
    subscribe('ludoready:event:project', listener),
  onRuntimeChanged: (listener: (status: RuntimeStatus) => void) =>
    subscribe('ludoready:event:runtime', listener),
  onApproval: (listener: (approval: ApprovalRequest) => void) =>
    subscribe('ludoready:event:approval', listener),
  onApprovalClosed: (listener: (token: string) => void) =>
    subscribe('ludoready:event:approval-closed', listener),
  onAssetsChanged: (listener: (payload: { projectId: string; assets: GameAssetRecord[] }) => void) =>
    subscribe('ludoready:event:assets', listener),
  onAssetPlansChanged: (listener: (payload: { projectId: string; assetPlans: AssetPlanRecord[] }) => void) =>
    subscribe('ludoready:event:asset-plans', listener),
};

contextBridge.exposeInMainWorld('ludoready', Object.freeze(api));
