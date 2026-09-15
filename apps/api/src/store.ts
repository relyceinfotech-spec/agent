import type { ResearchSession } from "./domain.js";

export interface SessionStore {
  create(session: ResearchSession): Promise<void>;
  get(id: string): Promise<ResearchSession | undefined>;
  update(session: ResearchSession): Promise<void>;
  list(): Promise<ResearchSession[]>;
  delete(id: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly data = new Map<string, ResearchSession>();
  async create(session: ResearchSession) {
    this.data.set(session.id, structuredClone(session));
  }
  async get(id: string) {
    const value = this.data.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async update(session: ResearchSession) {
    this.data.set(session.id, structuredClone(session));
  }
  async list(): Promise<ResearchSession[]> {
    return [...this.data.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((session) => structuredClone(session));
  }
  async delete(id: string) {
    this.data.delete(id);
  }
}
