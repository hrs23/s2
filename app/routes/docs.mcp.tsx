import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";
import { DocsPager } from "~/components/docs-pager";
import { Pre } from "~/components/docs-pre";
import { pageTitle } from "~/i18n/meta";

export function meta() {
  return [{ title: pageTitle("docs.mcp") }];
}

const MCP_URL = "https://s2.example.com/mcp";

const CLIENTS = ["chatgpt", "claudeAi"] as const;

const TOOLS = [
  "list",
  "stat",
  "read_text",
  "read_binary",
  "write",
  "write_binary",
  "mkdir",
  "move",
  "delete",
] as const;

const TROUBLESHOOTING = [
  "checkBeforeAllow",
  "connectionFailed",
  "outsideScope",
  "tokenExpired",
] as const;

export default function DocsMcpPage() {
  const { t } = useTranslation("docs");

  return (
    <div className="space-y-8 text-gray-700 leading-relaxed">
      <div>
        <h1 className="text-3xl font-bold mb-2">{t("mcp.title")}</h1>
        <p className="text-gray-600">{t("mcp.subtitle")}</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">{t("mcp.whenToUse.title")}</h2>
        <p>{t("mcp.whenToUse.body")}</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">{t("mcp.endpoint.title")}</h2>
        <Pre>{MCP_URL}</Pre>
      </section>

      <section className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold">{t("mcp.clients.title")}</h2>
          <p className="text-gray-600">{t("mcp.clients.subtitle")}</p>
        </div>

        {CLIENTS.map((key) => (
          <div key={key} className="space-y-2">
            <h3 className="text-lg font-semibold text-gray-900">
              {t(`mcp.clients.${key}.title`)}
            </h3>
            <ol className="list-decimal list-inside space-y-1 text-sm">
              {[1, 2, 3].map((n) => (
                <li key={n}>
                  <Trans
                    i18nKey={`mcp.clients.${key}.step${n}`}
                    ns="docs"
                    components={{ b: <strong /> }}
                  />
                </li>
              ))}
            </ol>
            <p className="text-sm text-gray-600">
              {t(`mcp.clients.${key}.note`)}
            </p>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">{t("mcp.tools.title")}</h2>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-gray-200 text-left">
              <th className="py-2 pr-4 font-semibold">
                {t("mcp.tools.col.tool")}
              </th>
              <th className="py-2 pr-4 font-semibold">
                {t("mcp.tools.col.permission")}
              </th>
              <th className="py-2 font-semibold">{t("mcp.tools.col.what")}</th>
            </tr>
          </thead>
          <tbody>
            {TOOLS.map((tool) => (
              <tr key={tool} className="border-b border-gray-100">
                <td className="py-2 pr-4 font-mono text-xs">files_{tool}</td>
                <td className="py-2 pr-4 text-gray-600">
                  {t(`mcp.tools.${tool}.permission`)}
                </td>
                <td className="py-2 text-gray-700">
                  {t(`mcp.tools.${tool}.what`)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">{t("mcp.manage.title")}</h2>
        <p>
          <Trans
            i18nKey="mcp.manage.body"
            ns="docs"
            components={{
              a: (
                <Link
                  to="/connections"
                  className="text-blue-600 hover:underline"
                />
              ),
              b: <strong />,
            }}
          />
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">{t("mcp.troubleshooting.title")}</h2>
        <div className="space-y-3">
          {TROUBLESHOOTING.map((key) => (
            <div key={key}>
              <p className="font-semibold text-gray-900 text-sm">
                {t(`mcp.troubleshooting.${key}.q`)}
              </p>
              <p className="text-sm text-gray-600">
                {t(`mcp.troubleshooting.${key}.a`)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <DocsPager current="mcp" />
    </div>
  );
}
