import { Trans, useTranslation } from "react-i18next";
import { DocsPager } from "~/components/docs-pager";
import { Pre } from "~/components/docs-pre";
import { pageTitle } from "~/i18n/meta";

export function meta() {
  return [{ title: pageTitle("docs.webdav") }];
}

export default function DocsWebdavPage() {
  const { t } = useTranslation("docs");

  return (
    <div className="space-y-8 text-gray-700 leading-relaxed">
      <div>
        <h1 className="text-3xl font-bold mb-2">{t("webdav.title")}</h1>
        <p className="text-gray-600">{t("webdav.subtitle")}</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">{t("webdav.connection.title")}</h2>
        <Pre>{`URL: https://s2.example.com/dav
Auth: Basic (any username, s2_ token as password)`}</Pre>
        <p>
          <Trans
            i18nKey="webdav.connection.text"
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
        <h2 className="text-2xl font-bold">{t("webdav.macos.title")}</h2>
        <ol className="list-decimal list-inside space-y-2">
          <li>{t("webdav.macos.step1")}</li>
          <li>
            <Trans
              i18nKey="webdav.macos.step2"
              ns="docs"
              components={{
                code: (
                  <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono" />
                ),
              }}
            />
          </li>
          <li>
            <Trans
              i18nKey="webdav.macos.step3"
              ns="docs"
              components={{
                code: (
                  <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono" />
                ),
              }}
            />
          </li>
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">{t("webdav.windows.title")}</h2>
        <ol className="list-decimal list-inside space-y-2">
          <li>{t("webdav.windows.step1")}</li>
          <li>
            <Trans
              i18nKey="webdav.windows.step2"
              ns="docs"
              components={{
                code: (
                  <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono" />
                ),
              }}
            />
          </li>
          <li>
            <Trans
              i18nKey="webdav.windows.step3"
              ns="docs"
              components={{
                code: (
                  <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono" />
                ),
              }}
            />
          </li>
        </ol>
      </section>

      <DocsPager current="webdav" />
    </div>
  );
}
