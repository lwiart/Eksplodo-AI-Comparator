import ReactMarkdown, { type Components } from 'react-markdown';

const isExternal = (href: string | undefined) => href !== undefined && /^(https?:)?\/\//i.test(href);

/** Lien vers l'application (chemin relatif, ancre) : sans objet hors de l'application. */
const isRelative = (href: string | undefined) => href !== undefined && !isExternal(href) && !/^[a-z][a-z0-9+.-]*:/i.test(href);

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

// Page publique : un lien relatif ne doit pas renvoyer vers l'application, il est rendu comme du texte.
const PUBLIC_COMPONENTS: Components = {
  ...COMPONENTS,
  a: ({ href, children }) =>
    isRelative(href) ? (
      <span>{children}</span>
    ) : isExternal(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <a href={href}>{children}</a>
    ),
};

/**
 * Réponse d'un modèle en Markdown assaini : HTML brut ignoré, jamais exécuté.
 * `relativeLinksAsText` (page publique) rend les liens relatifs comme du texte, sans lien.
 */
export function Markdown({ text, relativeLinksAsText = false }: { text: string; relativeLinksAsText?: boolean }) {
  return (
    <div className="markdown">
      <ReactMarkdown skipHtml components={relativeLinksAsText ? PUBLIC_COMPONENTS : COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
