export const reportLinks = [
  { name: 'GitHub', icon: 'github', url: 'https://github.com/reginna-chao/moo-family-bookshelf' },
  { name: 'Plurk', icon: 'plurk', url: 'https://www.plurk.com' },
  { name: 'Discord', icon: 'discord', url: 'https://discord.gg/placeholder' },
] as const;

export type ReportLink = (typeof reportLinks)[number];
