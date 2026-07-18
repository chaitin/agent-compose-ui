import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ServiceError } from './errors.mjs';
import { validateProjectDirectoryName } from './paths.mjs';

const METADATA_DIR = '.metadata';
const MANIFESTS_DIR = 'manifests';
const PROJECTS_FILE = 'projects.json';

export function canonicalProjectId(projectId) {
  const value = String(projectId ?? '');
  const canonical = value.startsWith('sha256:') ? value.slice(7) : value;
  if (!canonical || !/^[A-Za-z0-9_-]+$/.test(canonical)) {
    throw new ServiceError(400, 'INVALID_PATH', '项目 ID 无效');
  }
  return canonical;
}

async function writeJsonAtomic(target, value) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readJsonOrNull(target) {
  try {
    const content = await readFile(target, 'utf8');
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function createMetadataStore(root) {
  const metadataDir = path.join(root, METADATA_DIR);
  const manifestsDir = path.join(metadataDir, MANIFESTS_DIR);
  const projectsFile = path.join(metadataDir, PROJECTS_FILE);
  await mkdir(manifestsDir, { recursive: true, mode: 0o700 });

  async function readProjects() {
    const data = await readJsonOrNull(projectsFile);
    if (!data || !Array.isArray(data.projects)) return { version: 1, projects: [] };
    return { version: 1, projects: data.projects };
  }

  async function writeProjects(projects) {
    await writeJsonAtomic(projectsFile, projects);
  }

  async function ensureProject({ projectId, projectName }) {
    const canonical = canonicalProjectId(projectId);
    const directory = validateProjectDirectoryName(projectName);
    const projects = await readProjects();
    const existing = projects.projects.find((entry) => entry.directory === directory);
    if (existing) {
      if (existing.projectId !== canonical) {
        throw new ServiceError(409, 'ALREADY_EXISTS', '目录已被其他项目占用');
      }
      return { projectId: canonical, projectName: existing.projectName, directory };
    }
    await mkdir(path.join(root, directory), { recursive: true });
    projects.projects.push({ projectId: canonical, projectName: directory, directory });
    await writeProjects(projects);
    return { projectId: canonical, projectName: directory, directory };
  }

  function manifestPath(projectId) {
    return path.join(manifestsDir, `${canonicalProjectId(projectId)}.json`);
  }

  async function readManifest(projectId) {
    const data = await readJsonOrNull(manifestPath(projectId));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  }

  async function writeManifest(projectId, manifest) {
    const canonical = canonicalProjectId(projectId);
    if (!manifest || typeof manifest !== 'object' || manifest.version !== 1 ||
      !manifest.projectId || !Array.isArray(manifest.references) ||
      canonicalProjectId(manifest.projectId) !== canonical) {
      throw new ServiceError(400, 'INVALID_PATH', 'manifest 结构无效');
    }
    await writeJsonAtomic(manifestPath(canonical), manifest);
  }

  async function deleteManifest(projectId) {
    await rm(manifestPath(projectId), { force: true });
  }

  async function deleteProject(projectId) {
    const canonical = canonicalProjectId(projectId);
    const projects = await readProjects();
    const project = projects.projects.find((entry) => entry.projectId === canonical);
    if (!project) {
      await deleteManifest(canonical);
      return { deleted: false, projectId: canonical };
    }
    await rm(path.join(root, project.directory), { recursive: true, force: true });
    await deleteManifest(canonical);
    await writeProjects({ version: 1, projects: projects.projects.filter((entry) => entry.projectId !== canonical) });
    return { deleted: true, projectId: canonical, directory: project.directory };
  }

  return { ensureProject, readManifest, writeManifest, deleteManifest, deleteProject };
}
