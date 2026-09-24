// @vitest-environment jsdom
import { ThreadPrimitive, type AppendMessage, type ThreadMessageLike } from '@assistant-ui/react';
import type { ActionEvent } from '@openuidev/react-lang';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { ActiveSessionPermissionsProvider } from '@/hooks/useResourcePermissions.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { ListPermissionsResponse } from '@/server/types.js';
import { createMockAgentUIServer } from '../server/mockServer.js';
import { RuntimeHarness } from './RuntimeHarness.js';

const submitEvent: ActionEvent = {
  type: 'continue_conversation',
  params: {},
  humanFriendlyMessage: 'Decision submitted',
  formName: 'decision',
  formState: {
    decision: {
      decision: { value: 'approve', componentType: 'RadioGroup' },
      approved_amount: { value: '250000', componentType: 'Input' },
    },
  },
};

vi.mock('@openuidev/react-lang', () => ({
  Renderer: ({ onAction }: { onAction?: (event: ActionEvent) => void }) => (
    <div data-testid="aui-openui-renderer">
      <button type="button" onClick={() => onAction?.(submitEvent)}>
        Submit decision
      </button>
      <button
        type="button"
        onClick={() =>
          onAction?.({ type: 'open_url', params: { url: 'javascript:alert(1)' }, humanFriendlyMessage: '' })
        }
      >
        Unsafe link
      </button>
    </div>
  ),
}));

const OPENUI_MESSAGE = '```openui\nroot = Stack([form])\n```';

function textOf(message: AppendMessage): string {
  return message.content.map(part => (part.type === 'text' ? part.text : '')).join('');
}

function renderThread({
  messages,
  onNew,
  wrap = children => children,
}: {
  messages: ThreadMessageLike[];
  onNew: (message: AppendMessage) => Promise<void>;
  wrap?: (children: ReactNode) => ReactNode;
}) {
  return render(
    <RuntimeHarness messages={messages} onNew={onNew}>
      {wrap(<ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>)}
    </RuntimeHarness>,
  );
}

/** Lets an append that would have been scheduled reach the runtime before asserting it did not. */
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

async function clickSubmit(index = 0) {
  await waitFor(() => {
    expect(screen.getAllByText('Submit decision').length).toBeGreaterThan(index);
  });
  fireEvent.click(screen.getAllByText('Submit decision')[index]!);
}

describe('OpenUI form submission', () => {
  it('sends the form values as a JSON user message from the latest assistant message', async () => {
    const onNew = vi.fn(async (_message: AppendMessage) => {});
    renderThread({ messages: [{ role: 'assistant', content: OPENUI_MESSAGE }], onNew });

    await clickSubmit();

    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(1));
    const text = textOf(onNew.mock.calls[0]![0]);
    expect(text.startsWith('Decision submitted\n\n```json\n')).toBe(true);
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    expect(JSON.parse(json)).toEqual({
      form: 'decision',
      values: { decision: 'approve', approved_amount: '250000' },
      params: {},
    });
  });

  it('ignores submissions from historical assistant messages', async () => {
    const onNew = vi.fn(async (_message: AppendMessage) => {});
    renderThread({
      messages: [
        { role: 'assistant', content: OPENUI_MESSAGE },
        { role: 'user', content: 'later message' },
        { role: 'assistant', content: 'plain reply' },
      ],
      onNew,
    });

    await clickSubmit();
    await settle();
    expect(onNew).not.toHaveBeenCalled();
  });

  it('ignores submissions when the session is read-only', async () => {
    const onNew = vi.fn(async (_message: AppendMessage) => {});
    const server = createMockAgentUIServer({
      permissions: { listPermissions: vi.fn(() => new Promise<ListPermissionsResponse>(() => undefined)) },
    });
    renderThread({
      messages: [{ role: 'assistant', content: OPENUI_MESSAGE }],
      onNew,
      wrap: children => (
        <ServerProvider server={server}>
          <ActiveSessionPermissionsProvider sessionId="someone-elses-session">
            {children}
          </ActiveSessionPermissionsProvider>
        </ServerProvider>
      ),
    });

    await clickSubmit();
    await settle();
    expect(onNew).not.toHaveBeenCalled();
  });

  it('refuses to open non-http links', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderThread({ messages: [{ role: 'assistant', content: OPENUI_MESSAGE }], onNew: async () => {} });

    await waitFor(() => expect(screen.getByText('Unsafe link')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Unsafe link'));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
