import { Trans, useTranslation } from "react-i18next";
import { DocsPager } from "~/components/docs-pager";
import { Pre } from "~/components/docs-pre";
import { pageTitle } from "~/i18n/meta";

export function meta() {
  return [{ title: pageTitle("docs.rest") }];
}

export default function DocsRestPage() {
  const { t } = useTranslation("docs");

  return (
    <div className="space-y-8 text-gray-700 leading-relaxed">
      <div>
        <h1 className="text-3xl font-bold mb-2">{t("rest.title")}</h1>
        <p className="text-gray-600">{t("rest.subtitle")}</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">{t("rest.whenToUse.title")}</h2>
        <p>{t("rest.whenToUse.body")}</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">{t("rest.connection.title")}</h2>
        <Pre>{`Base URL: https://s2.example.com
Auth:     Authorization: Bearer s2_xxx`}</Pre>
        <p>
          <Trans
            i18nKey="rest.connection.text"
            ns="docs"
            components={{
              code: (
                <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono" />
              ),
            }}
          />
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">{t("rest.examples.title")}</h2>
        <Pre>{`# List the root directory
curl -H "Authorization: Bearer $S2_TOKEN" \\
  https://s2.example.com/api/v1/files/

# Download a file
curl -H "Authorization: Bearer $S2_TOKEN" \\
  -o readme.txt \\
  https://s2.example.com/api/v1/files/readme.txt

# Upload a file
curl -X PUT \\
  -H "Authorization: Bearer $S2_TOKEN" \\
  --data-binary @readme.txt \\
  https://s2.example.com/api/v1/files/readme.txt

# Delete a file
curl -X DELETE \\
  -H "Authorization: Bearer $S2_TOKEN" \\
  https://s2.example.com/api/v1/files/readme.txt

# Move or rename
curl -X POST \\
  -H "Authorization: Bearer $S2_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"from":"draft.txt","to":"docs/readme.txt"}' \\
  https://s2.example.com/api/v1/files-move

# Copy a file
curl -X POST \\
  -H "Authorization: Bearer $S2_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"from":"docs/readme.txt","to":"docs/readme-copy.txt"}' \\
  https://s2.example.com/api/v1/files-copy

# Create a directory
curl -X POST \\
  -H "Authorization: Bearer $S2_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"path":"docs/notes"}' \\
  https://s2.example.com/api/v1/files-mkdir

# Inspect the calling token (Bearer-only)
curl -H "Authorization: Bearer $S2_TOKEN" \\
  https://s2.example.com/api/v1/token`}</Pre>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">{t("rest.spec.title")}</h2>
        <p>
          <Trans
            i18nKey="rest.spec.body"
            ns="docs"
            components={{
              a: (
                // biome-ignore lint/a11y/useAnchorContent: Trans fills children from the translation.
                <a
                  href="/openapi.yaml"
                  className="text-blue-600 hover:underline"
                />
              ),
            }}
          />
        </p>
      </section>

      <DocsPager current="rest" />
    </div>
  );
}
