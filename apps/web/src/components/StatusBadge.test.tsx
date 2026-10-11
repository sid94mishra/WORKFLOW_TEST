import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it.each([
    ['pending', 'Pending'],
    ['up', 'Up'],
    ['degraded', 'Degraded'],
    ['down', 'Down'],
  ] as const)('shows %s as text', (status, text) => {
    render(<StatusBadge status={status} enabled />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('shows Paused when disabled regardless of status', () => {
    render(<StatusBadge status="up" enabled={false} />);
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText('Up')).toBeNull();
  });
});
