export interface CrawlerInput {
    email: string;
    password: string;
    channels: string[];
    cookies: EditThisCookie[]
}

export interface EditThisCookie {
    domain: string
    expirationDate: number
    hostOnly: boolean
    httpOnly: boolean
    name: string
    path: string
    sameSite: string
    secure: boolean
    session: boolean
    storeId: string
    value: string
    id: number
}

export interface MemberSoftData {
    displayName: string
    userName: string
}
