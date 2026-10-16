import { useAuth } from '../auth/AuthProvider';
import { Card } from '../components/ui/Card';

export function DashboardPage() {
  const { user } = useAuth();
  return (
    <div>
      <h1 className="m-0 mb-5 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">
        Bonjour {user?.name}
      </h1>
      <Card className="py-10 text-center">
        <p className="m-0 text-sm text-mute">Les séries et les classements arriveront ici.</p>
      </Card>
    </div>
  );
}
