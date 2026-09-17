#!/usr/bin/env node
/**
 * Mirrors multipi bus traffic into the local Opengram dashboard.
 *
 * This is intentionally a one-way, read-only bridge: the dashboard is an
 * observability UI and never impersonates an agent to write back to the bus.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const busUrl = (process.env.PI_BUS_URL || 'http://127.0.0.1:43871').replace(/\/$/, '');
const dashboardUrl = (process.env.MULTIPI_DASHBOARD_URL || 'http://127.0.0.1:43872').replace(/\/$/, '');
const dashboardHome = process.env.OPENGRAM_HOME || path.join(homedir(), '.pi', 'bus', 'dashboard');
const statePath = path.join(dashboardHome, 'multipi-bridge.json');
const pollRetryMs = 1500;

/** @typedef {{ id:number, from:string, to:string, subject:'task'|'question'|'reply', content:string, attachment:string[], replyTo?:number, createdAt:string }} BusMessage */

function readState() {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.version === 2 && state.messages && state.groups) return state;

    // Dashboard versions before connected groups kept one global room. Archive it
    // below and rebuild the grouped view from bus history.
    return { version: 2, legacyChatId: state.chatId || null, lastBusId: 0, messages: {}, groups: {} };
  } catch {
    return { version: 2, legacyChatId: null, lastBusId: 0, messages: {}, groups: {} };
  }
}

function saveState(state) {
  mkdirSync(dashboardHome, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function request(url, init, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : undefined;
    if (response.ok) return body;

    if (response.status === 429 && attempt + 1 < attempts) {
      const retryAfterMs = Math.max(250, Number(response.headers.get('retry-after') || 1) * 1000);
      console.warn(`[multipi-dashboard] dashboard write rate limited; retrying in ${retryAfterMs}ms`);
      await sleep(retryAfterMs);
      continue;
    }

    throw new Error(body?.error?.message || body?.error || `HTTP ${response.status}: ${url}`);
  }
}

async function waitForDashboard() {
  while (true) {
    try {
      await request(`${dashboardUrl}/api/v1/health`);
      return;
    } catch {
      await sleep(pollRetryMs);
    }
  }
}

function groupMessages(messages) {
  const groups = new Map();
  for (const message of messages) {
    const key = `${message.from}\u0000${message.subject}\u0000${message.content}\u0000${message.createdAt}\u0000${message.replyTo || ''}`;
    const group = groups.get(key) || { first: message, dests: [], ids: [] };
    group.dests.push(message.to);
    group.ids.push(message.id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function connectedGroups(messages) {
  const parent = new Map();
  const find = (agent) => {
    if (!parent.has(agent)) parent.set(agent, agent);
    const root = parent.get(agent);
    if (root !== agent) parent.set(agent, find(root));
    return parent.get(agent);
  };
  const join = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  for (const message of Object.values(messages)) join(message.from, message.to);

  const groups = new Map();
  for (const message of Object.values(messages)) {
    const root = find(message.from);
    const group = groups.get(root) || { members: new Set(), messages: [] };
    group.members.add(message.from);
    group.members.add(message.to);
    group.messages.push(message);
    groups.set(root, group);
  }

  return [...groups.values()].map((group) => ({
    members: [...group.members].sort(),
    messages: group.messages.sort((left, right) => left.id - right.id),
  }));
}

function groupKey(members) {
  return members.join('\u0000');
}

function groupTitle(members) {
  return members.join(' · ');
}

async function archiveChat(chatId) {
  await request(`${dashboardUrl}/api/v1/chats/${encodeURIComponent(chatId)}/archive`, { method: 'POST' });
}

async function createGroupChat(members) {
  return request(`${dashboardUrl}/api/v1/chats`, {
    method: 'POST',
    body: JSON.stringify({
      agentIds: ['multipi-bus'],
      modelId: 'multipi-bus',
      title: groupTitle(members),
      tags: ['multipi', 'bus', 'connected-agents'],
    }),
  });
}

async function rebuildGroups(state) {
  if (state.legacyChatId) {
    try { await archiveChat(state.legacyChatId); } catch {}
    state.legacyChatId = null;
  }

  for (const group of Object.values(state.groups)) {
    try { await archiveChat(group.chatId); } catch {}
  }

  state.groups = {};
  for (const component of connectedGroups(state.messages)) {
    const key = groupKey(component.members);
    const chat = await createGroupChat(component.members);
    const group = { chatId: chat.id, busToDashboard: {} };
    state.groups[key] = group;
    await mirrorMessagesIntoGroup(state, group, component.messages);
  }
  saveState(state);
}

async function mirrorMessagesIntoGroup(state, group, messages) {
  for (const messageGroup of groupMessages(messages)) {
    const message = messageGroup.first;
    if (messageGroup.ids.every((id) => group.busToDashboard[String(id)])) continue;

    const replyDashboardId = message.replyTo ? group.busToDashboard[String(message.replyTo)] : undefined;
    const trace = {
      multipi: {
        busMessageIds: messageGroup.ids,
        subject: message.subject,
        recipients: messageGroup.dests,
        attachments: message.attachment,
        replyToBusId: message.replyTo || null,
        replyToDashboardId: replyDashboardId || null,
      },
    };

    const result = await request(`${dashboardUrl}/api/v1/chats/${encodeURIComponent(group.chatId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'agent', senderId: message.from, content: message.content, trace }),
    });
    for (const id of messageGroup.ids) group.busToDashboard[String(id)] = result.id;
  }
}

function componentKeys(messages) {
  return connectedGroups(messages).map((component) => groupKey(component.members)).sort();
}

function sameComponents(left, right) {
  const leftKeys = componentKeys(left);
  const rightKeys = componentKeys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
}

async function mirrorMessages(state, messages) {
  const previousMessages = Object.values(state.messages);
  const newMessages = [];
  for (const message of messages) {
    if (!state.messages[String(message.id)]) {
      state.messages[String(message.id)] = message;
      state.lastBusId = Math.max(state.lastBusId, message.id);
      newMessages.push(message);
    }
  }
  if (!newMessages.length) return;

  const allMessages = Object.values(state.messages);
  const components = connectedGroups(allMessages);
  const groupsReady = components.every((component) => state.groups[groupKey(component.members)]);
  if (!groupsReady || !sameComponents(previousMessages, allMessages)) {
    await rebuildGroups(state);
    return;
  }

  for (const component of components) {
    const group = state.groups[groupKey(component.members)];
    const messagesForGroup = newMessages.filter((message) => component.members.includes(message.from));
    if (messagesForGroup.length) await mirrorMessagesIntoGroup(state, group, messagesForGroup);
  }
  saveState(state);
}

async function syncSince(state) {
  const { messages } = await request(`${busUrl}/messages/since?afterId=${state.lastBusId}&limit=1000`);
  if (messages.length) await mirrorMessages(state, messages);
}

async function subscribe(state) {
  while (true) {
    try {
      const response = await fetch(`${busUrl}/events/all`, { headers: { accept: 'text/event-stream' } });
      if (!response.ok || !response.body) throw new Error(`Bus event stream failed: HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (data) {
            const event = JSON.parse(data);
            if (event.type === 'message') await mirrorMessages(state, [event.message]);
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      console.error(`[multipi-dashboard] bus subscription interrupted: ${error.message || error}`);
      await sleep(pollRetryMs);
    }
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const state = readState();
await waitForDashboard();
try {
  await syncSince(state);
} catch (error) {
  console.error(`[multipi-dashboard] ${error.message || error}`);
  process.exit(1);
}
console.log(`[multipi-dashboard] mirroring ${busUrl} into ${dashboardUrl}`);
await subscribe(state);
