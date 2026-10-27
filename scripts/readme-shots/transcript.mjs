// Claude Code の transcript（.jsonl）を書く小さな道具。
// 偽の claude（fake-claude.mjs）と、過去の会話の見本づくり（seed.ts）が使う。
// 形は packages/server/test/fixtures/claude/2.1.310/transcript.jsonl に合わせてある。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CLAUDE_VERSION = '2.1.310';
export const MODEL = 'claude-sonnet-5-5';

/** cwd を projects/ の下の名前にする。英数字以外は - になる。 */
export function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function transcriptPath(claudeDir, cwd, sessionId) {
  return path.join(claudeDir, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
}

const uuid = () => crypto.randomUUID();

export class TranscriptWriter {
  constructor({ file, sessionId, cwd, title, gitBranch = 'main' }) {
    this.file = file;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.gitBranch = gitBranch;
    this.parent = null;
    this.turn = 0;
    this.promptId = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file) && title) {
      this.#raw({ type: 'custom-title', customTitle: title, sessionId });
      this.#raw({ type: 'agent-name', agentName: title, sessionId });
    }
  }

  #raw(obj) {
    fs.appendFileSync(this.file, JSON.stringify(obj) + '\n');
  }

  #base(ts) {
    const id = uuid();
    const base = {
      parentUuid: this.parent,
      isSidechain: false,
      uuid: id,
      timestamp: new Date(ts).toISOString(),
      userType: 'external',
      entrypoint: 'cli',
      cwd: this.cwd,
      sessionId: this.sessionId,
      version: CLAUDE_VERSION,
      gitBranch: this.gitBranch,
    };
    this.parent = id;
    return base;
  }

  /** 人の発言。新しいターンが始まる。 */
  user(text, ts = Date.now()) {
    this.turn += 1;
    this.promptId = uuid();
    this.#raw({
      ...this.#base(ts),
      promptId: this.promptId,
      type: 'user',
      message: { role: 'user', content: text },
      permissionMode: 'default',
      origin: { kind: 'human' },
      promptSource: 'typed',
      turnOrigin: 'human',
      turnPosition: { promptIndex: this.turn, turnIndex: this.turn },
    });
  }

  /** assistant の 1 ブロック。block は { type:'text', text } か { type:'tool_use', id, name, input }。 */
  assistant(block, ts = Date.now(), stop = 'tool_use') {
    this.#raw({
      ...this.#base(ts),
      type: 'assistant',
      message: {
        model: MODEL,
        id: 'msg_' + crypto.randomBytes(12).toString('hex'),
        type: 'message',
        role: 'assistant',
        content: [block],
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 3, cache_creation_input_tokens: 1200, cache_read_input_tokens: 24000, output_tokens: 180 },
      },
      requestId: 'req_' + crypto.randomBytes(10).toString('hex'),
    });
  }

  text(text, ts = Date.now(), final = false) {
    this.assistant({ type: 'text', text }, ts, final ? 'end_turn' : 'tool_use');
  }

  toolUse(name, input, ts = Date.now()) {
    const id = 'toolu_' + crypto.randomBytes(12).toString('hex');
    this.assistant({ type: 'tool_use', id, name, input }, ts);
    return id;
  }

  toolResult(toolUseId, content, ts = Date.now()) {
    this.#raw({
      ...this.#base(ts),
      promptId: this.promptId,
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
      sourceToolAssistantUUID: this.parent,
    });
  }
}
