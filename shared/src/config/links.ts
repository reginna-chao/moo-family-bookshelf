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

/** The forgot-secret recovery request: the feedback form, prefilled with the recovery topic. */
export function getVerifyRecoveryLink({
  appVersion,
}: {
  appVersion: string;
}): string {
  const params = new URLSearchParams({
    platform: "googleform",
    topic: "recovery",
    v: appVersion,
  });
  return `${FEEDBACK_PAGE}?${params.toString()}`;
}
