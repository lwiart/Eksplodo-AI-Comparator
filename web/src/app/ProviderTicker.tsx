import { MORE_PROVIDERS } from '../three/providers';

function Chips({ hidden = false }: { hidden?: boolean }) {
  return (
    <div className="flex gap-2" aria-hidden={hidden || undefined}>
      {MORE_PROVIDERS.map((p) => (
        <span
          key={p.name}
          className="flex items-center gap-1.5 rounded-full border border-line bg-night-0/55 py-1 pr-2.5 pl-1 font-mono text-[11px] font-semibold whitespace-nowrap text-[#b9d4e1]"
        >
          <img src={p.icon} alt="" className="size-5 rounded-full bg-[#f2f7fa] p-0.5" />
          {p.name}
        </span>
      ))}
    </div>
  );
}

/** Bandeau défilant des autres fournisseurs (grand écran). Le défilement s'arrête au survol et si les animations sont coupées. */
export function ProviderTicker() {
  return (
    <div data-testid="provider-ticker" className="pointer-events-auto absolute right-[3%] bottom-6 z-10 hidden w-[min(700px,50vw)] text-right lg:block">
      <div className="ticker-window overflow-hidden">
        <div className="ticker-track flex w-max gap-2">
          <Chips />
          <Chips hidden />
        </div>
      </div>
      <p className="mt-2 mb-0 font-mono text-[11px] font-semibold tracking-[0.08em] text-mute">
        … ET BIEN D'AUTRES : <b className="font-semibold text-peach">TOUT MODÈLE ACCESSIBLE PAR API</b>
      </p>
    </div>
  );
}
