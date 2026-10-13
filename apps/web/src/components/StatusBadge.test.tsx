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

  describe('maintenance', () => {
    const maintenance = {
      id: '50000000-0000-4000-8000-000000000001',
      title: 'DB upgrade',
      startsAt: '2026-10-20T01:00:00.000Z',
      endsAt: '2026-10-20T03:30:00.000Z',
    };

    it('shows a blue Maintenance badge titled with the window and end time', () => {
      render(<StatusBadge status="down" enabled maintenance={maintenance} />);
      const badge = screen.getByText('Maintenance');
      expect(badge).toHaveAttribute('title', 'DB upgrade · until 03:30 UTC');
      expect(badge).toHaveClass('bg-blue-100', 'text-blue-900');
      expect(screen.queryByText('Down')).toBeNull();
    });

    it('lets Paused win and ignores a null maintenance', () => {
      const { rerender } = render(
        <StatusBadge status="up" enabled={false} maintenance={maintenance} />,
      );
      expect(screen.getByText('Paused')).toBeInTheDocument();
      expect(screen.queryByText('Maintenance')).toBeNull();
      rerender(<StatusBadge status="up" enabled maintenance={null} />);
      expect(screen.getByText('Up')).not.toHaveAttribute('title');
    });
  });
});
