import ReactMarkdown, { type Components } from 'react-markdown';

const isExternal = (href: string | undefined) => href !== undefined && /^(https?:)?\/\//i.test(href);

const COMPONENTS: Components = {
  // Aucune image distante : une réponse de modèle ne doit pas déclencher de requête vers un tiers.
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  a: ({ href, children }) =>
    isExternal(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <a href={href}>{children}</a>
    ),
};

/** Réponse d'un modèle en Markdown assaini : HTML brut ignoré, jamais exécuté. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown skipHtml components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
