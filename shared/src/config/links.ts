import { githubIcon } from "../icons/github";
import { plurkIcon } from "../icons/plurk";
import { discordIcon } from "../icons/discord";

export const reportLinks = [
  { name: "GitHub", svgPath: githubIcon.path, url: "https://github.com/reginna-chao/moo-family-bookshelf" },
  { name: "Plurk", svgPath: plurkIcon.path, url: "https://www.plurk.com" },
  { name: "Discord", svgPath: discordIcon.path, url: "https://discord.gg/placeholder" },
] as const;

export type ReportLink = (typeof reportLinks)[number];
