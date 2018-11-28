// Parses the development applications at the South Australian Yorke Peninsula Council web site
// and places them in a database.
//
// Michael Bone
// 25th November 2018

"use strict";

import * as cheerio from "cheerio";
import * as request from "request-promise-native";
import * as sqlite3 from "sqlite3";
import * as moment from "moment";

sqlite3.verbose();

const DevelopmentApplicationsUrl = "https://yorke.sa.gov.au/development/development-information/development-register/?pagenum={0}&gv_search=&filter_1=&filter_3=&gv_start={1}&gv_end={2}&filter_7=&mode=all"
const CommentUrl = "mailto:admin@yorke.sa.gov.au";

declare const process: any;

// Sets up an sqlite database.

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text, [on_notice_from] text, [on_notice_to] text)");
            resolve(database);
        });
    });
}

// Inserts a row in the database if it does not already exist.

async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.reason,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate,
            null,
            null
        ], function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and reason \"${developmentApplication.reason}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and reason \"${developmentApplication.reason}\" because it was already present in the database.`);
                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// Gets a random integer in the specified range: [minimum, maximum).

function getRandom(minimum: number, maximum: number) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}

// Pauses for the specified number of milliseconds.

function sleep(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();

    // Retrieve the paged results of a search for the last month.

    let pageNumber = 1;

    let dateFrom = encodeURIComponent(moment().subtract(1, "months").format("DD/MM/YYYY"));
    let dateTo = encodeURIComponent(moment().format("DD/MM/YYYY"));
    let developmentApplicationsUrl = DevelopmentApplicationsUrl.replace(/\{0\}/g, pageNumber.toString()).replace(/\{1\}/g, dateFrom).replace(/\{2\}/g, dateTo);

    console.log(`Retrieving page: ${developmentApplicationsUrl}`);
    let body = await request({ url: developmentApplicationsUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);

    // Parse the search results.

    let urls = [];
    for (let trElement of $("table.gv-table-view tr").get()) {
        for (let tdElement of $(trElement).find("td").get()) {
            // console.log($(tdElement).text());
            if ($(tdElement).find("a").attr("href") !== undefined) {
                let url = $(tdElement).find("a").attr("href");
                if (url !== undefined)
                    urls.push(url);
                console.log(url);
            }
            // let key: string = $(paragraphElement).children("span.key").text().trim();
            // let value: string = $(paragraphElement).children("span.inputField").text().trim();
            // if (key === "Type of Work")
            //     reason = value;
            // else if (key === "Application No.")
            //     applicationNumber = value;
            // else if (key === "Date Lodged")
            //     receivedDate = moment(value, "D/MM/YYYY", true);  // allows the leading zero of the day to be omitted
        }
    }

    console.log(`Examining each development application on the page.`);
    for (let url of urls) {
        let body = await request({ url: url, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
        let $ = cheerio.load(body);
        for (let trElement of $("table.gv-table-view-content tr").get()) {
            let key = $(trElement).find("th").text().toUpperCase().trim();

            if (key === "DA NUMBER") {
                let value = $(trElement).find("td").text().trim();
                console.log(`${key}: ${value}`);
            } else if (key === "DATE APPLICATION RECEIVED") {
                let value = $(trElement).find("td").text().trim();
                console.log(`${key}: ${value}`);
            } else if (key === "DEVELOPMENT DETAILS") {
                let value = $(trElement).find("td").text().trim();
                console.log(`${key}: ${value}`);
            } else if (key === "DEVELOPMENT ADDRESS") {
                let value = $(trElement).find("td").html().replace(/<br\s*[\/]?>/gi, "\n").replace(/<a\s.*?>.*?<\/a>/gi, "").trim();
                console.log(`${key}: ${value}`);
            }
        }
    }

    // Ensure that at least an application number and address have been obtained.
    //
    // if (applicationNumber !== "" && address !== "") {
    //     await insertRow(database, {
    //         applicationNumber: applicationNumber,
    //         address: address,
    //         reason: reason,
    //         informationUrl: DevelopmentApplicationsUrl,
    //         commentUrl: CommentUrl,
    //         scrapeDate: moment().format("YYYY-MM-DD"),
    //         receivedDate: receivedDate.isValid ? receivedDate.format("YYYY-MM-DD") : ""
    //     });
    // }
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
