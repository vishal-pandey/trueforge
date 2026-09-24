'use client';

import { Renderer, type ActionEvent } from '@openuidev/react-lang';
import { ThemeProvider, openuiLibrary } from '@openuidev/react-ui';

import { useOptionalContentClassNames } from '../theme/ThemeProvider.js';
import { cn } from './lib/cn.js';

export type OpenUiFenceBlockProps = {
  content: string;
  isStreaming?: boolean;
  darkTheme?: boolean;
  /** Receives button/form actions; omit to render the block inert. */
  onAction?: (event: ActionEvent) => void;
};

export function OpenUiFenceBlock({ content, isStreaming, darkTheme, onAction }: OpenUiFenceBlockProps) {
  const classNames = useOptionalContentClassNames();

  return (
    <div className={cn('aui-openui mb-2 w-full min-w-0 max-w-full', classNames.openui?.root)}>
      <ThemeProvider mode={darkTheme ? 'dark' : 'light'} cssSelector=".markdown-openui-scope">
        <div
          className={cn('markdown-openui-scope min-w-0 w-full max-w-full overflow-x-auto', classNames.openui?.scope)}
        >
          <Renderer response={content} library={openuiLibrary} isStreaming={isStreaming} onAction={onAction} />
        </div>
      </ThemeProvider>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    OpenUiFenceBlock: typeof OpenUiFenceBlock;
  }
}
