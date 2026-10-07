import { err } from "~/lib/utils/http.server";

export function loader() {
  return err(404, "Not Found");
}

export function action() {
  return err(404, "Not Found");
}
