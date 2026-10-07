import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { DocsPager } from "~/components/docs-pager";
import { pageTitle } from "~/i18n/meta";

export function meta() {
  return [{ title: pageTitle("docs.index") }];
}

export default function DocsIndex() {
  const { t } = useTranslation("docs");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">{t("index.title")}</h1>
        <p className="text-gray-600">{t("index.subtitle")}</p>
      </div>

      <section className="space-y-4 text-gray-700 leading-relaxed">
        <h2 className="text-2xl font-bold">
          {t("index.gettingStarted.title")}
        </h2>

        <div className="space-y-3">
          <h3 className="text-lg font-semibold text-gray-900">
            {t("index.gettingStarted.step1.title")}
          </h3>
          <p>
            {t("index.gettingStarted.step1.text")}{" "}
            <a href="/login" className="text-blue-600 hover:underline">
              {t("index.gettingStarted.step1.link")}
            </a>
            .
          </p>
        </div>

        <div className="space-y-3">
          <h3 className="text-lg font-semibold text-gray-900">
            {t("index.gettingStarted.step2.title")}
          </h3>
          <p>{t("index.gettingStarted.step2.text")}</p>
        </div>

        <div className="space-y-3">
          <h3 className="text-lg font-semibold text-gray-900">
            {t("index.gettingStarted.step3.title")}
          </h3>
          <p>
            {t("index.gettingStarted.step3.text1")}{" "}
            <Link to="/docs/rest" className="text-blue-600 hover:underline">
              {t("index.gettingStarted.step3.linkRest")}
            </Link>
            ,{" "}
            <Link to="/docs/mcp" className="text-blue-600 hover:underline">
              {t("index.gettingStarted.step3.linkMcp")}
            </Link>
            ,{" "}
            <Link to="/docs/webdav" className="text-blue-600 hover:underline">
              {t("index.gettingStarted.step3.linkWebdav")}
            </Link>
            .
          </p>
          <p>
            {t("index.gettingStarted.step3.text2")}{" "}
            <Link to="/tokens" className="text-blue-600 hover:underline">
              {t("index.gettingStarted.step3.linkTokens")}
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-bold">{t("index.accessMethods.title")}</h2>

        <div className="space-y-4">
          <Link
            to="/docs/rest"
            className="block p-5 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-start gap-4">
              <span className="text-2xl mt-0.5">&#123;&#125;</span>
              <div>
                <p className="font-semibold text-gray-900">
                  {t("index.accessMethods.rest.title")}
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  {t("index.accessMethods.rest.desc")}
                </p>
                <p className="text-xs text-gray-400 mt-2">
                  {t("index.accessMethods.rest.recommended")}
                </p>
              </div>
            </div>
          </Link>

          <Link
            to="/docs/mcp"
            className="block p-5 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-start gap-4">
              <span className="text-2xl mt-0.5">&#10024;</span>
              <div>
                <p className="font-semibold text-gray-900">
                  {t("index.accessMethods.mcp.title")}
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  {t("index.accessMethods.mcp.desc")}
                </p>
                <p className="text-xs text-gray-400 mt-2">
                  {t("index.accessMethods.mcp.recommended")}
                </p>
              </div>
            </div>
          </Link>

          <Link
            to="/docs/webdav"
            className="block p-5 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-start gap-4">
              <span className="text-2xl mt-0.5">&#128193;</span>
              <div>
                <p className="font-semibold text-gray-900">
                  {t("index.accessMethods.webdav.title")}
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  {t("index.accessMethods.webdav.desc")}
                </p>
                <p className="text-xs text-gray-400 mt-2">
                  {t("index.accessMethods.webdav.recommended")}
                </p>
              </div>
            </div>
          </Link>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">{t("index.aiAgents.title")}</h2>
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-sm">
          <p>
            <a
              href="/llms.txt"
              className="text-blue-600 hover:underline font-mono"
            >
              /llms.txt
            </a>{" "}
            &mdash; {t("index.aiAgents.llmsTxt")}
          </p>
        </div>
      </section>

      <DocsPager current="index" />
    </div>
  );
}
