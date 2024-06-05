export interface CrawlerConfig {
    startUrls: string[];
    maxRequestsPerCrawl: number;
}

// Structure of input is defined in input_schema.json
export const config: CrawlerConfig = {
    startUrls: ['https://discord.com/channels/@me'],
    maxRequestsPerCrawl: 100,
};
