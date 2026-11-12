import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CompanyConnections } from './CompanyConnections';
import { useOsConnections } from '../../stores/osConnections';

describe('<CompanyConnections>', () => {
  beforeEach(() => {
    useOsConnections.setState({
      load: vi.fn(async () => {}),
      state: {
        hosted: true, reachable: true, error: null, fetchedAt: null, profile: 'business', osPublicUrl: 'https://os.example', osToolsEnabled: true, servers: [],
        entitled: ['zendesk', 'shopify'],
        needsConsent: [{ system: 'zendesk', label: 'Zendesk', connectUrl: 'https://os.example/ask/connections' }],
      },
      tools: { enabled: true, reachable: true, tools: [
        { name: 'shopify_search_orders', title: null, description: null, system: 'shopify', readOnly: true },
        { name: 'zendesk_search_tickets', title: null, description: null, system: 'zendesk', readOnly: true },
        { name: 'os_list_connections', title: null, description: null, system: 'os', readOnly: null },
      ] },
    });
  });

  it('a system that needs consent shows its Connect card, never "Connected"; OS\'s own tools are not a system', () => {
    render(<CompanyConnections />);
    expect(screen.getByText('Shopify')).toBeTruthy();
    expect(screen.getAllByText('Connected')).toHaveLength(1);
    expect(screen.queryByText('Zendesk')).toBeNull();
    expect(screen.getByText('Connect Zendesk')).toBeTruthy();
    expect(screen.queryByText('os')).toBeNull();
  });
});
