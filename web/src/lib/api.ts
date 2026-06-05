/**
 * API client with typed endpoints
 * Automatically includes auth token in Bearer header
 */

const API_BASE = '/api';

interface ApiError {
  detail?: string;
  message?: string;
}

// ── Venue Area types ────────────────────────────────────────
export interface VenueArea {
  id: string;
  event_id: string;
  name: string;
  layout_type: string;
  rows: number;
  cols: number;
  display_order: number;
  offset_x: number;
  offset_y: number;
  stage_label: string | null;
  seat_count: number;
}

export interface VenueAreaCreate {
  name: string;
  layout_type?: string;
  rows?: number;
  cols?: number;
  display_order?: number;
  offset_x?: number;
  offset_y?: number;
  stage_label?: string | null;
}

export interface AgentConfig {
  name: string;
  model_tier: string;
  system_prompt: string;
  enabled: boolean;
  default_model_tier: string;
  default_prompt_preview: string;
  has_custom_prompt: boolean;
  gen_model_tier: string;
  default_gen_model_tier: string;
}

export interface AgentConfigDetail extends AgentConfig {
  default_system_prompt: string;
}

export interface AgentConfigPatch {
  model_tier?: string;
  system_prompt?: string;
  enabled?: boolean;
  gen_model_tier?: string;
}

// ── Structured Message Parts (from agent) ──────────────────
export interface MessagePart {
  type: 'seat_map' | 'attendee_table' | 'event_card' | 'page_preview'
    | 'confirmation' | 'file_link' | 'stats' | 'text';
  [key: string]: any;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  tier?: string;        // legacy hint; catalog API does not always supply it
  context: string;
  vision?: boolean;     // true if provider/ID heuristic says it accepts images
}

export interface LLMProviderInfo {
  label: string;
  provider: string;
  model: string;
  api_key_masked: string;
  api_key_set: boolean;
  base_url: string;
  has_override: boolean;
}

export interface AvailableProvider {
  provider: string;
  label: string;
  model: string;
  base_url: string;
  has_key: boolean;
}

export interface LLMProviderPatch {
  model?: string;
  api_key?: string;
  base_url?: string;
  provider?: string;
}

/**
 * Build a friendly error message from a non-OK Response. Handles three
 * cases that show up in production:
 *   - JSON error body  → `{detail}` field, fall back to `message`
 *   - HTML error page  → nginx 502/504 / Cloudflare style; we get back
 *     `<html>...</html>` and the old code crashed parsing it as JSON
 *   - empty body       → use the status code label
 *
 * Never throws — returns a string the caller can rethrow.
 */
async function readErrorMessage(
  response: Response,
  status: number,
): Promise<string> {
  const fallback = `HTTP ${status}`;
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    return fallback;
  }
  if (!raw.trim()) return fallback;

  const ct = (response.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as ApiError;
      return parsed.detail || parsed.message || fallback;
    } catch {
      // fall through
    }
  }

  // HTML page (nginx/cloudflare error) — surface a clean message
  if (raw.trimStart().startsWith('<')) {
    if (status === 502) return '服务暂时不可达 (502)，后端可能在重启';
    if (status === 504) return '请求超时 (504)，后端处理时间过长';
    if (status >= 500) return `服务异常 (${status})，请稍后重试`;
    return fallback;
  }

  // Plain-text body — return up to 200 chars
  return raw.slice(0, 200) || fallback;
}

/**
 * Parse a successful Response as JSON, but never let a stray HTML
 * heartbeat or whitespace blow up `JSON.parse`. Returns the parsed
 * object on success; throws a descriptive error otherwise.
 */
async function safeJson<T = unknown>(
  response: Response,
  context: string,
): Promise<T> {
  const raw = await response.text();
  if (!raw.trim()) {
    throw new Error(`${context}: empty response body`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    const head = raw.trimStart().slice(0, 60);
    throw new Error(
      `${context}: 响应不是合法 JSON（前 60 字符: ${head}...）`,
    );
  }
}

export class ApiClient {
  private getToken(): string | null {
    return localStorage.getItem('token');
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestInit
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options?.headers && typeof options.headers === 'object') {
      Object.assign(headers, options.headers);
    }

    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    });

    if (response.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }

    if (!response.ok) {
      let errorData: ApiError = {};
      try {
        errorData = (await response.json()) as ApiError;
      } catch {
        throw new Error(`服务器错误 (${response.status})`);
      }
      throw new Error(errorData.detail || errorData.message || 'API Error');
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  // Auth
  async login(email: string, password: string) {
    return this.request('POST', '/v1/auth/login', { email, password });
  }

  async register(email: string, password: string, name: string, phone?: string) {
    return this.request('POST', '/v1/auth/register', { email, password, name, phone });
  }

  async getMe() {
    return this.request('GET', '/v1/auth/me');
  }

  // Events
  async getEvents(status?: string) {
    const query = status ? `?status=${status}` : '';
    return this.request('GET', `/events/${query}`);
  }

  async getEvent(eventId: string) {
    return this.request('GET', `/events/${eventId}`);
  }

  async createEvent(data: {
    name: string;
    event_date?: string;
    location?: string;
    venue_rows: number;
    venue_cols: number;
    layout_type: string;
    config?: Record<string, unknown>;
  }) {
    return this.request('POST', '/events/', data);
  }

  async updateEvent(eventId: string, data: Record<string, unknown>) {
    return this.request('PATCH', `/events/${eventId}`, data);
  }

  async deleteEvent(eventId: string) {
    return this.request('DELETE', `/events/${eventId}`);
  }

  async activateEvent(eventId: string) {
    return this.request('POST', `/events/${eventId}/activate`, {});
  }

  async completeEvent(eventId: string) {
    return this.request('POST', `/events/${eventId}/complete`, {});
  }

  async cancelEvent(eventId: string) {
    return this.request('POST', `/events/${eventId}/cancel`, {});
  }

  async duplicateEvent(eventId: string) {
    return this.request('POST', `/events/${eventId}/duplicate`, {});
  }

  // Attendees
  async getAttendees(eventId: string, params?: Record<string, string>) {
    const query = new URLSearchParams(params || {}).toString();
    const separator = query ? '?' : '';
    return this.request('GET', `/events/${eventId}/attendees${separator}${query}`);
  }

  async createAttendee(
    eventId: string,
    data: {
      name: string;
      title?: string;
      organization?: string;
      role: string;
      phone?: string;
      email?: string;
    }
  ) {
    return this.request('POST', `/events/${eventId}/attendees`, data);
  }

  async updateAttendee(eventId: string, attendeeId: string, data: Record<string, unknown>) {
    return this.request('PATCH', `/events/${eventId}/attendees/${attendeeId}`, data);
  }

  async deleteAttendee(eventId: string, attendeeId: string) {
    return this.request('DELETE', `/events/${eventId}/attendees/${attendeeId}`);
  }

  async checkinAttendee(eventId: string, attendeeId: string) {
    return this.request('POST', `/events/${eventId}/attendees/${attendeeId}/checkin`, {});
  }

  // Dashboard
  async getDashboard(eventId: string) {
    return this.request('GET', `/v1/dashboard/${eventId}`);
  }

  // Custom-page artifact probe (public endpoint, no /api prefix).
  // Tells the design tab whether a staged page is sitting in front of live.
  async getCheckinPageStatus(eventId: string): Promise<{
    has_live: boolean;
    has_staging: boolean;
    has_backup: boolean;
  }> {
    const r = await fetch(`/p/${eventId}/checkin/page-status`);
    if (!r.ok) {
      // Be permissive: a probe failure should not break the design tab.
      return { has_live: false, has_staging: false, has_backup: false };
    }
    return r.json();
  }

  // Import
  async previewImport(eventId: string, file: File) {
    const formData = new FormData();
    formData.append('file', file);

    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(
      `${API_BASE}/v1/events/${eventId}/attendees/import-preview`,
      { method: 'POST', headers, body: formData }
    );

    if (response.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }
    if (!response.ok) {
      // Use the shared helper so we don't blow up trying to JSON.parse a
      // plain-text "Internal Server Error" body when the backend 500s.
      throw new Error(await readErrorMessage(response, response.status));
    }
    return safeJson(response, 'import preview');
  }

  async confirmImport(
    eventId: string,
    file: File,
    columnMappings: Record<string, string>,
    skipDuplicates: boolean = true,
  ) {
    // Multipart POST: the backend re-parses the xlsx, so the file is
    // re-uploaded here. column_mappings is JSON-encoded into a form field.
    const formData = new FormData();
    formData.append('file', file);
    formData.append('column_mappings', JSON.stringify(columnMappings));
    formData.append('skip_duplicates', String(skipDuplicates));

    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(
      `${API_BASE}/v1/events/${eventId}/attendees/import-confirm`,
      { method: 'POST', headers, body: formData },
    );

    if (response.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }
    if (!response.ok) {
      throw new Error(await readErrorMessage(response, response.status));
    }
    return safeJson(response, 'import confirm');
  }

  // Seats
  async getSeats(eventId: string) {
    return this.request('GET', `/events/${eventId}/seats`);
  }

  async createSeatGrid(eventId: string, rows: number, cols: number) {
    return this.request('POST', `/events/${eventId}/seats/grid?rows=${rows}&cols=${cols}`, {});
  }

  async createSeatLayout(
    eventId: string,
    body: {
      layout_type: string;
      rows: number;
      cols: number;
      table_size?: number;
      spacing?: number;
    },
  ) {
    return this.request('POST', `/events/${eventId}/seats/layout`, body);
  }

  async createCustomLayout(
    eventId: string,
    rowSpecs: Array<{
      count: number;
      repeat?: number;
      spacing?: number;
      zone?: string;
      label_prefix?: string;
    }>,
  ) {
    return this.request('POST', `/events/${eventId}/seats/custom-layout`, {
      row_specs: rowSpecs,
    });
  }

  async autoAssignSeats(eventId: string, strategy: string = 'random') {
    return this.request('POST', `/events/${eventId}/seats/auto-assign`, { strategy });
  }

  async updateSeat(eventId: string, seatId: string, data: Record<string, unknown>) {
    return this.request('PATCH', `/events/${eventId}/seats/${seatId}`, data);
  }

  async bulkUpdateSeats(
    eventId: string,
    body: {
      seat_ids: string[];
      zone?: string | null;
      seat_type?: string;
      pos_dx?: number;
      pos_dy?: number;
    },
  ) {
    return this.request('PATCH', `/events/${eventId}/seats/bulk`, body);
  }

  async bulkDeleteSeats(eventId: string, seatIds: string[]) {
    return this.request<{ deleted: number }>(
      'DELETE',
      `/events/${eventId}/seats/bulk`,
      { seat_ids: seatIds },
    );
  }

  // ── Venue Areas ───────────────────────────────────────────
  async getAreas(eventId: string) {
    return this.request<VenueArea[]>('GET', `/events/${eventId}/areas`);
  }

  async createArea(eventId: string, data: VenueAreaCreate) {
    return this.request<VenueArea>('POST', `/events/${eventId}/areas`, data);
  }

  async updateArea(eventId: string, areaId: string, data: Partial<VenueAreaCreate>) {
    return this.request<VenueArea>('PATCH', `/events/${eventId}/areas/${areaId}`, data);
  }

  async deleteArea(eventId: string, areaId: string) {
    return this.request<void>('DELETE', `/events/${eventId}/areas/${areaId}`);
  }

  async generateAreaLayout(eventId: string, areaId: string) {
    return this.request<any[]>('POST', `/events/${eventId}/areas/${areaId}/layout`);
  }

  async suggestZones(eventId: string) {
    return this.request<{ zones: any[]; total_rows: number }>(
      'GET', `/events/${eventId}/seats/suggest-zones`
    );
  }

  async assignSeat(eventId: string, seatId: string, attendeeId: string) {
    return this.request('POST', `/events/${eventId}/seats/${seatId}/assign?attendee_id=${attendeeId}`, {});
  }

  async swapSeats(eventId: string, seatAId: string, seatBId: string) {
    return this.request('POST', `/events/${eventId}/seats/swap?seat_a_id=${seatAId}&seat_b_id=${seatBId}`, {});
  }

  // Export
  getExportAttendeesUrl(eventId: string) {
    return `${API_BASE}/v1/events/${eventId}/export/attendees`;
  }

  getExportSeatmapUrl(eventId: string) {
    return `${API_BASE}/v1/events/${eventId}/export/seatmap`;
  }

  getExportBadgesUrl(
    eventId: string,
    templateName = 'business',
    templateId?: string,
    roles?: string[],
  ) {
    const params = new URLSearchParams({ template_name: templateName });
    if (templateId) params.set('template_id', templateId);
    if (roles && roles.length > 0) params.set('roles', roles.join(','));
    return `${API_BASE}/v1/events/${eventId}/export/badges/html?${params}`;
  }

  getBadgePreviewUrl(
    eventId: string,
    templateName = 'business',
    templateId?: string,
  ) {
    const params = new URLSearchParams({ template_name: templateName });
    if (templateId) params.set('template_id', templateId);
    return `${API_BASE}/v1/events/${eventId}/export/badges/preview?${params}`;
  }

  /** Standalone template preview (no eventId needed) — for global template management page */
  getTemplatePreviewUrl(templateName = 'conference', templateId?: string) {
    const params = new URLSearchParams({ template_name: templateName });
    if (templateId) params.set('template_id', templateId);
    return `${API_BASE}/v1/badge-templates/preview?${params}`;
  }

  // ── Event Files ──────────────────────────────────────────────
  async uploadEventFile(eventId: string, file: File) {
    const formData = new FormData();
    formData.append('file', file);

    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(
      `${API_BASE}/v1/events/${eventId}/files`,
      { method: 'POST', headers, body: formData }
    );
    if (response.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }
    if (!response.ok) {
      const err = (await response.json()) as ApiError;
      throw new Error(err.detail || 'Upload failed');
    }
    return response.json();
  }

  async listEventFiles(eventId: string) {
    return this.request('GET', `/v1/events/${eventId}/files`);
  }

  getEventFileUrl(eventId: string, fileId: string) {
    return `${API_BASE}/v1/events/${eventId}/files/${fileId}`;
  }

  async deleteEventFile(eventId: string, fileId: string) {
    return this.request('DELETE', `/v1/events/${eventId}/files/${fileId}`);
  }

  // ── Agent Chat (multipart for files) ─────────────────────────
  async sendAgentChat(
    message: string,
    opts?: {
      eventId?: string;
      sessionId?: string;
      scope?: string;   // e.g. "organizer", "badge", "checkin"
      files?: File[];
    }
  ): Promise<{
    reply: string;
    session_id: string;
    event_id: string | null;
    action_taken: string | null;
    task_plan: any[] | null;
    tool_calls: {
      tool_name: string;
      tool_name_zh: string;
      status: string;
      summary: string;
    }[] | null;
    parts: MessagePart[] | null;
    quick_replies: { label: string; value: string; style?: string }[] | null;
  }> {
    const formData = new FormData();
    formData.append('message', message);
    if (opts?.eventId) formData.append('event_id', opts.eventId);
    if (opts?.sessionId) formData.append('session_id', opts.sessionId);
    if (opts?.scope) formData.append('scope', opts.scope);
    if (opts?.files) opts.files.forEach((f) => formData.append('files', f));

    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`${API_BASE}/v1/agent/chat`, {
      method: 'POST', headers, body: formData,
    });
    if (response.status === 401) {
      // Only redirect on confirmed auth failures (no token / token rejected
      // twice). A single 401 mid-upload is often a transient race between
      // token-load and request firing — surface a friendlier error and
      // let the caller decide.
      if (!token) {
        window.location.href = '/login';
      }
      throw new Error('登录已失效，请刷新页面后重试');
    }
    if (!response.ok) {
      throw new Error(await readErrorMessage(response, response.status));
    }
    return safeJson(response, 'agent chat');
  }

  /**
   * Stream agent chat via SSE — yields progress events in real-time.
   * Falls back to regular /chat if streaming fails.
   */
  async *streamAgentChat(
    message: string,
    opts?: {
      eventId?: string;
      sessionId?: string;
      scope?: string;
      files?: File[];
    }
  ): AsyncGenerator<{
    event: string;
    [key: string]: any;
  }> {
    const formData = new FormData();
    formData.append('message', message);
    if (opts?.eventId) formData.append('event_id', opts.eventId);
    if (opts?.sessionId) formData.append('session_id', opts.sessionId);
    if (opts?.scope) formData.append('scope', opts.scope);
    if (opts?.files) opts.files.forEach((f) => formData.append('files', f));

    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`${API_BASE}/v1/agent/chat/stream`, {
      method: 'POST', headers, body: formData,
    });

    if (response.status === 401) {
      if (!token) {
        window.location.href = '/login';
      }
      throw new Error('登录已失效，请刷新页面后重试');
    }
    if (!response.ok) {
      throw new Error(await readErrorMessage(response, response.status));
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No stream body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            yield data;
          } catch {
            // skip malformed lines
          }
        }
      }
    }
  }

  // Legacy text-only chat (backward compat)
  async sendChatMessage(message: string, eventId?: string, sessionId?: string) {
    return this.sendAgentChat(message, { eventId, sessionId });
  }

  // Agent feedback (self-evolution)
  async sendAgentFeedback(eventId: string, feedback: number) {
    return this.request('POST', '/v1/agent/chat/feedback', {
      event_id: eventId,
      feedback,
    });
  }

  // Agent stats (self-evolution)
  async getAgentStats(eventId: string) {
    return this.request('GET', `/v1/agent/chat/stats/${eventId}`);
  }

  // Badge Templates
  async getBadgeTemplates(templateType?: string) {
    const query = templateType ? `?template_type=${templateType}` : '';
    return this.request('GET', `/v1/badge-templates/${query}`);
  }

  async createBadgeTemplate(data: {
    name: string;
    template_type: string;
    html_template: string;
    css: string;
    style_category?: string;
  }) {
    return this.request('POST', '/v1/badge-templates/', data);
  }

  async updateBadgeTemplate(templateId: string, data: Record<string, unknown>) {
    return this.request('PATCH', `/v1/badge-templates/${templateId}`, data);
  }

  async deleteBadgeTemplate(templateId: string) {
    return this.request('DELETE', `/v1/badge-templates/${templateId}`);
  }

  // Agent Config
  async getAgentConfigs() {
    return this.request<AgentConfig[]>('GET', '/v1/agent-config');
  }

  async getAgentConfig(name: string) {
    return this.request<AgentConfigDetail>('GET', `/v1/agent-config/${name}`);
  }

  async updateAgentConfig(name: string, data: Partial<AgentConfigPatch>) {
    return this.request<AgentConfigDetail>('PATCH', `/v1/agent-config/${name}`, data);
  }

  async resetAgentConfig(name: string) {
    return this.request<AgentConfigDetail>('POST', `/v1/agent-config/${name}/reset`);
  }

  // LLM Providers
  async getAvailableModels(refresh: boolean = false) {
    const path = refresh
      ? '/v1/llm-providers/models?refresh=true'
      : '/v1/llm-providers/models';
    return this.request<Record<string, ModelInfo[]>>('GET', path);
  }

  async getLLMProviders() {
    return this.request<Record<string, LLMProviderInfo>>('GET', '/v1/llm-providers');
  }

  async updateLLMProvider(tier: string, data: LLMProviderPatch) {
    return this.request<Record<string, LLMProviderInfo>>('PATCH', `/v1/llm-providers/${tier}`, data);
  }

  async resetLLMProviders() {
    return this.request<Record<string, LLMProviderInfo>>('POST', '/v1/llm-providers/reset');
  }

  async getAvailableProviders() {
    return this.request<AvailableProvider[]>('GET', '/v1/llm-providers/available');
  }
}

export const apiClient = new ApiClient();
