import { githubIcon } from "../icons/github";
import { googleFormIcon } from "../icons/googleform";
import { plurkIcon } from "../icons/plurk";

export interface ReportLink {
  name: string;
  svgPath: string;
  url: string;
}

const FEEDBACK_PAGE =
  "https://reginna-chao.github.io/moo-family-bookshelf/feedback.html";

export function getReportLinks(opts: {
  appVersion: string;
}): readonly ReportLink[] {
  const googleFormParams = new URLSearchParams({
    platform: "googleform",
    v: opts.appVersion,
  });
  return [
    {
      name: "GoogleForm",
      svgPath: googleFormIcon.path,
      url: `${FEEDBACK_PAGE}?${googleFormParams.toString()}`,
    },
    {
      name: "GitHub",
      svgPath: githubIcon.path,
      url: "https://github.com/reginna-chao/moo-family-bookshelf",
    },
    {
      name: "Plurk",
      svgPath: plurkIcon.path,
      url: `${FEEDBACK_PAGE}?platform=plurk`,
    },
  ];
}
