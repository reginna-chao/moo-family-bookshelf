import { githubIcon } from "../icons/github";
import { plurkIcon } from "../icons/plurk";

export const reportLinks = [
  { name: "GitHub", svgPath: githubIcon.path, url: "https://github.com/reginna-chao/moo-family-bookshelf" },
  { name: "Plurk", svgPath: plurkIcon.path, url: "https://www.plurk.com/p/3gyz74peep" },
] as const;

export type ReportLink = (typeof reportLinks)[number];
