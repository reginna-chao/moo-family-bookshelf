import { siGithub, siPlurk, siDiscord } from "simple-icons";

export const reportLinks = [
  { name: "GitHub", svgPath: siGithub.path, url: "https://github.com/reginna-chao/moo-family-bookshelf" },
  { name: "Plurk", svgPath: siPlurk.path, url: "https://www.plurk.com" },
  { name: "Discord", svgPath: siDiscord.path, url: "https://discord.gg/placeholder" },
] as const;

export type ReportLink = (typeof reportLinks)[number];
