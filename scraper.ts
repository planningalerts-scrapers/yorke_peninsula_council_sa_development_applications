// Parses the development applications at the South Australian Yorke Peninsula Council web site
// and places them in a database.
//
// Michael Bone
// 25th November 2018

"use strict";

import * as fs from "fs";
import * as cheerio from "cheerio";
import * as request from "request-promise-native";
import * as sqlite3 from "sqlite3";
import * as moment from "moment";
import * as didyoumean from "didyoumean2";

sqlite3.verbose();

const DevelopmentApplicationsUrl = "https://yorke.sa.gov.au/development/development-information/development-register/?pagenum={0}&gv_search=&filter_1=&filter_3=&gv_start={1}&gv_end={2}&filter_7=&mode=all"
const CommentUrl = "mailto:admin@yorke.sa.gov.au";

declare const process: any;

// Address information.

let SuburbNames = null;

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
            developmentApplication.description,
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
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and description \"${developmentApplication.description}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and description \"${developmentApplication.description}\" because it was already present in the database.`);
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
    // Read the suburb names.

    SuburbNames = {};
    for (let line of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let suburbTokens = line.toUpperCase().split(",");
        SuburbNames[suburbTokens[0].toUpperCase().trim()] = suburbTokens[1].toUpperCase().trim();
    }

    // Ensure that the database exists.

    let database = await initializeDatabase();

    // Retrieve the paged results of a search for the last month.

    let pageNumber = 0;

    while (pageNumber++ < 50) {  // safety precaution
        let dateFrom = encodeURIComponent(moment().subtract(1, "months").format("DD/MM/YYYY"));
        let dateTo = encodeURIComponent(moment().format("DD/MM/YYYY"));
        let developmentApplicationsUrl = DevelopmentApplicationsUrl.replace(/\{0\}/g, pageNumber.toString()).replace(/\{1\}/g, dateFrom).replace(/\{2\}/g, dateTo);

        console.log(`Retrieving page ${pageNumber}: ${developmentApplicationsUrl}`);
        let body = await request({ url: developmentApplicationsUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
        await sleep(2000 + getRandom(0, 5) * 1000);
        let $ = cheerio.load(body);

        // Parse the search results.

        for (let trElement of $("table.gv-table-view tr").get()) {
            let url = $(trElement).find("#gv-field-31-1 a").attr("href");
            if (url === undefined)
                continue;

            // Obtain the description for the application.

            let childBody = await request({ url: url, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
            let childPage = cheerio.load(childBody);

            let address = $(trElement).find("#gv-field-31-7").text().trim();
            let applicationNumber = "";
            let receivedDate = moment.invalid();
            let description = "";

            for (let trElement of childPage("table.gv-table-view-content tr").get()) {
                let key = childPage(trElement).find("th").text().toUpperCase().trim();

                if (key === "DA NUMBER")
                    applicationNumber = childPage(trElement).find("td").text().trim();
                else if (key === "DATE APPLICATION RECEIVED")
                    receivedDate = moment(childPage(trElement).find("td").text().trim(), "D/MM/YYYY", true);
                else if (key === "DEVELOPMENT DETAILS")
                    description = childPage(trElement).find("td").text().trim().replace(/&apos;/g, "'");
            }

            // Ensure that at least an application number and address have been obtained.
            
            if (applicationNumber !== "" && applicationNumber !== undefined && address !== "" && address !== undefined) {
                await insertRow(database, {
                    applicationNumber: applicationNumber,
                    address: address,
                    description: description,
                    informationUrl: DevelopmentApplicationsUrl,
                    commentUrl: CommentUrl,
                    scrapeDate: moment().format("YYYY-MM-DD"),
                    receivedDate: receivedDate.isValid ? receivedDate.format("YYYY-MM-DD") : ""
                });
            }
        }

        // If there is no "next page" link then assume this is the last page.

        let hasNextPageLink = ($("ul.page-numbers li a.next").length > 0);
        if (!hasNextPageLink)
            break;
    }
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
