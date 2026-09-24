'use client';

import { useAui } from '@assistant-ui/react';
import type { ActionEvent } from '@openuidev/react-lang';
import { useCallback, useRef } from 'react';

// String literals instead of the library's enum keep OpenUI out of the eager chat bundle.
const CONTINUE_CONVERSATION = 'continue_conversation';
const OPEN_URL = 'open_url';

export type OpenUiActionHandler = (event: ActionEvent) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Field values keyed by field name; the renderer stores each field as `{ value, componentType }`. */
export function flattenOpenUiFormValues(event: Pick<ActionEvent, 'formState' | 'formName'>): Record<string, unknown> {
  const state = event.formState ?? {};
  const scoped = event.formName !== undefined ? state[event.formName] : undefined;
  const fields = isRecord(scoped) ? scoped : state;
  const values: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    values[name] = isRecord(field) && 'value' in field ? field['value'] : field;
  }
  return values;
}

/** The user message sent for a form submission: the button's message, then the values as fenced JSON. */
export function formatOpenUiSubmission(event: ActionEvent): string {
  const label = event.humanFriendlyMessage.trim() || 'Form submitted';
  const payload = { form: event.formName, values: flattenOpenUiFormValues(event), params: event.params };
  return `${label}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stable OpenUI `onAction` handler. Conversation actions post a user message only while `canSubmit`
 * holds (latest message, done streaming, session manageable); links open for http(s) only.
 */
export function useOpenUiActionHandler(canSubmit: boolean): OpenUiActionHandler {
  const aui = useAui();
  // Read through a ref so the handler identity stays stable and OpenUI forms keep their state.
  const canSubmitRef = useRef(canSubmit);
  canSubmitRef.current = canSubmit;

  return useCallback(
    (event: ActionEvent) => {
      if (event.type === OPEN_URL) {
        const url = safeExternalUrl(event.params['url']);
        if (url !== undefined && typeof window !== 'undefined') {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
        return;
      }
      if (event.type !== CONTINUE_CONVERSATION || !canSubmitRef.current) return;
      // Guards double submits until the appended message makes this block historical.
      canSubmitRef.current = false;
      aui.thread().append(formatOpenUiSubmission(event));
    },
    [aui],
  );
}
