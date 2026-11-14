import { useRoute } from './lib/router';
import { AuditPage } from './pages/AuditPage';
import { CounterpartyPage } from './pages/CounterpartyPage';
import { Landing } from './pages/Landing';
import { LivePage } from './pages/LivePage';
import { PolicyPage } from './pages/PolicyPage';
import { RedTeamPage } from './pages/RedTeamPage';
import { SettingsPage } from './pages/SettingsPage';
import { SetupPage } from './pages/SetupPage';

export function App() {
  switch (useRoute()) {
    case '/live': return <LivePage />;
    case '/red-team': return <RedTeamPage />;
    case '/audit': return <AuditPage />;
    case '/counterparty': return <CounterpartyPage />;
    case '/policy': return <PolicyPage />;
    case '/setup': return <SetupPage />;
    case '/settings': return <SettingsPage />;
    default: return <Landing />;
  }
}
