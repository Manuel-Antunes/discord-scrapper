import { Cookie, Page } from 'playwright';
import { EditThisCookie } from './types.js';

export function editThisCookieToPlaywrightCookie(cookies: EditThisCookie[]): Cookie[] {
    return cookies.map((cookie) => {
        const sameSiteMap = {
            unspecified: 'None',
            lax: 'Lax',
            no_restriction: 'Strict',
        } as const;

        return {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: Math.floor(cookie.expirationDate as unknown as number),
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: sameSiteMap[cookie.sameSite as keyof typeof sameSiteMap],
        };
    });
}

export async function crawInfiniteList<T>(page: Page,
    listSelector: string, elementSelector: string,
    elementCallback: (element: HTMLElement) => T, transferDataCallback: (data: T) => Promise<void | true>) {
    const selectedElements: T[] = [];
    let stop = false;
    async function transferData(data: T) {
        if (!stop) {
            selectedElements.push(data);
            stop = !!(await transferDataCallback(data));
        }
    }

    for await (const element of await page.$$(elementSelector)) {
        if (!stop) {
            const data = await element.evaluate(elementCallback);
            await transferData(data);
        } else {
            break;
        }
    }

    function observeMutation(args: string) {
        const { selector,
            elementSelector: elSelector,
            elementCallback: elCallback } = JSON.parse(args);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        async function onMutationHandler(mutationsList) {
            for (const mutation of mutationsList) {
                if (mutation.addedNodes.length) {
                    for (const node of mutation.addedNodes) {
                        const element = node.querySelector(elSelector);
                        // eslint-disable-next-line no-new-func
                        const data = new Function('element', `return (${elCallback})(element)`)(element);
                        await transferData(data);
                    }
                }
            }
        }
        const observer = new MutationObserver(onMutationHandler);
        const virtualizedList = document.querySelector(selector);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        observer.observe(virtualizedList, { childList: true, subtree: true });
    }
    await page.exposeFunction('transferData', transferData);
    await page.exposeFunction('elementCallback', elementCallback);
    await page.evaluate(observeMutation, JSON.stringify({
        selector: listSelector,
        elementSelector,
        elementCallback: elementCallback.toString(),
    }));
    let retryScrollCount = 3;

    while (retryScrollCount > 0 && !stop) {
        try {
            const element = await page.$(listSelector);
            if (!element) throw new Error(`Element not found: ${listSelector}`);
            const scrollPosition = await element?.evaluate((el) => el.scrollTop);
            await element.evaluate((el) => el.scrollBy({ top: 200, behavior: 'smooth' }));
            await new Promise((resolve) => setTimeout(resolve, 500));

            await page.waitForFunction(`document.querySelector('${listSelector}').scrollTop > ${scrollPosition}`, {}, {
                timeout: 1000,
            });
            retryScrollCount = 3;
        } catch (error) {
            retryScrollCount--;
        }
    }
    return selectedElements;
}
