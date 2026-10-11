import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadgeSnippet } from './BadgeSnippet';

const origin = 'https://pulse.example.com';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BadgeSnippet', () => {
  it('shows previews and absolute Markdown snippets', () => {
    render(<BadgeSnippet monitorId="abc" origin={origin} />);
    expect(screen.getByLabelText('Uptime badge (Markdown)')).toHaveValue(
      '![uptime](https://pulse.example.com/badge/abc.svg)',
    );
    expect(screen.getByLabelText('Status badge (Markdown)')).toHaveValue(
      '![status](https://pulse.example.com/badge/abc.svg?type=status)',
    );
    expect(screen.getByAltText('uptime badge')).toHaveAttribute('src', `${origin}/badge/abc.svg`);
    expect(screen.getByAltText('status badge')).toHaveAttribute(
      'src',
      `${origin}/badge/abc.svg?type=status`,
    );
  });

  it('copies to the clipboard and shows Copied for 2 seconds', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<BadgeSnippet monitorId="abc" origin={origin} />);
    await user.click(screen.getAllByRole('button', { name: 'Copy' })[0]!);
    expect(writeText).toHaveBeenCalledWith('![uptime](https://pulse.example.com/badge/abc.svg)');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });

  it('falls back to selecting the text when the clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    render(<BadgeSnippet monitorId="abc" origin={origin} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Copy' })[1]!);
    expect(await screen.findByRole('button', { name: 'Press Ctrl+C to copy' })).toBeInTheDocument();
    expect(screen.getByLabelText('Status badge (Markdown)')).toHaveFocus();
  });

  it('falls back when the clipboard rejects', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    render(<BadgeSnippet monitorId="abc" origin={origin} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]!);
    expect(await screen.findByRole('button', { name: 'Press Ctrl+C to copy' })).toBeInTheDocument();
  });
});
