import { describe, expect, it } from 'vitest';

import { flattenOpenUiFormValues, formatOpenUiSubmission } from '@/hooks/useOpenUiActionHandler.js';

describe('flattenOpenUiFormValues', () => {
  it('unwraps field wrappers from the whole store when no form name is given', () => {
    expect(
      flattenOpenUiFormValues({
        formState: { notes: { value: 'ok', componentType: 'TextArea' }, $flag: true },
      }),
    ).toEqual({ notes: 'ok', $flag: true });
  });
});

describe('formatOpenUiSubmission', () => {
  it('falls back to a generic label', () => {
    const text = formatOpenUiSubmission({
      type: 'continue_conversation',
      params: { context: 'loan-1' },
      humanFriendlyMessage: '  ',
      formName: 'decision',
      formState: { decision: { decision: { value: 'decline', componentType: 'RadioGroup' } } },
    });
    expect(text).toBe(
      'Form submitted\n\n```json\n' +
        JSON.stringify({ form: 'decision', values: { decision: 'decline' }, params: { context: 'loan-1' } }, null, 2) +
        '\n```',
    );
  });
});
