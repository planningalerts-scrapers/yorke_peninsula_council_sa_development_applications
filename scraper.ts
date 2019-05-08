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

const DevelopmentApplicationsUrl = "https://yorke.sa.gov.au/development/development-information/development-register/?pagenum={0}&gv_search=&filter_1=&filter_3=&gv_start={1}&gv_end={2}&filter_7=&mode=all";
const InformationUrl = "https://yorke.sa.gov.au/development/development-information/development-register/?gv_search=&filter_1={0}&filter_3=&gv_start=&gv_end=&filter_7=&mode=all";
const CommentUrl = "mailto:admin@yorke.sa.gov.au";

declare const process: any;

// Address information.

let SuburbNames = undefined;
let HundredNames = undefined;

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

// Inserts a row in the database if the row does not already exist.

async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or replace into [data] values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
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
                sqlStatement.finalize();  // releases any locks
                console.log(`    Saved: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                resolve(true);  // indicate row was inserted
            }
        });
    });
}

// Updates the inforation URL in a row in the database.

async function updateRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("update [data] set [info_url] = ? where [info_url] like 'https://yorke.sa.gov.au/development/development-information/development-register/entry/%' and [council_reference] = ?");
        sqlStatement.run([ developmentApplication.informationUrl, developmentApplication.applicationNumber ],
        function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
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

// Format the address, ensuring that it has a valid suburb name, state and post code.

function formatAddress(address: string) {
    // Remove a dot at the start of the address such as in ". HD CLINTON" or a dot in the middle
    // of an address such as in "7 The Esplanade . MARION BAY".  Remove any hundred name in
    // brackets (that often appears after the suburb name) such as in "106 Sultana Point Road
    // EDITHBURGH (Hd Melville)".  Replace multiple consecutive spaces with single spaces.

    address = address.replace(/^\. /g, " ").replace(/ \. /g, " ").replace(/ \(Hd.*?\)/gi, "").replace(/\s\s+/g, " ").trim();
    if (address === "")
        return address;

    // Do not attempt to format the address if it ends in a hundred name.  Otherwise the hundred
    // name may be incorrectly interpreted as a suburb name.  For example, "HD CLINTON"

    let uppercaseAddress = address.toUpperCase();
    for (let hundredName of HundredNames) {
        if (uppercaseAddress.toUpperCase() === "HD " + hundredName || uppercaseAddress.endsWith(" HD " + hundredName)) {
            console.log(`The state and post code will not be added because the address ends with a hundred name: ${address}`);
            return address;
        }
    }

    // Extract tokens from the end of the array until a valid suburb name is encountered
    // (allowing for a spelling error).  Prefer a longer suburb name over a shorter suburb
    // name.  For example, prefer "PORT CLINTON" over "CLINTON".

    let tokens = address.split(" ");

    let suburbName = null;
    for (let index = 4; index >= 1; index--) {
        let suburbNameMatch = didyoumean(tokens.slice(-index).join(" "), Object.keys(SuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 1, trimSpace: true });
        if (suburbNameMatch !== null) {
            suburbName = SuburbNames[suburbNameMatch];
            tokens.splice(-index, index);  // remove elements from the end of the array           
            break;
        }
    }

    if (suburbName === null) {  // suburb name not found (or not recognised)
        console.log(`The state and post code will not be added because the suburb was not recognised: ${address}`);
        return address;
    }

    // Add the suburb name with its state and post code to the street name.

    let streetName = tokens.join(" ").trim();
    return (streetName + ((streetName === "") ? "" : ", ") + suburbName).trim();
}

// Parses the development applications in the specified date range.

async function parse(dateFrom: moment.Moment, dateTo: moment.Moment, database) {
    console.log(`Retrieving development applications from ${dateFrom.format("YYYY-MM-DD")} to ${dateTo.format("YYYY-MM-DD")}.`);

    let dateFromText = encodeURIComponent(dateFrom.format("DD/MM/YYYY"));
    let dateToText = encodeURIComponent(dateTo.format("DD/MM/YYYY"));

    // Step through each page of the results for the specified date range.

    let pageNumber = 0;
    while (pageNumber++ < 100) {  // safety precaution
        let developmentApplicationsUrl = DevelopmentApplicationsUrl.replace(/\{0\}/g, pageNumber.toString()).replace(/\{1\}/g, dateFromText).replace(/\{2\}/g, dateToText);
        console.log(`Retrieving page ${pageNumber}: ${developmentApplicationsUrl}`);

        let body = await request({ url: developmentApplicationsUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
        await sleep(2000 + getRandom(0, 5) * 1000);
        let $ = cheerio.load(body);

        // Parse the search results.

        for (let trElement of $("table.gv-table-view tr").get()) {
            let developmentApplicationUrl = $(trElement).find("#gv-field-31-1 a").attr("href");
            if (developmentApplicationUrl === undefined)
                continue;

            // Obtain the description for the application.

            let childBody = await request({ url: developmentApplicationUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
            let childPage = cheerio.load(childBody);

            let address = formatAddress($(trElement).find("#gv-field-31-7").text().trim());
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
                let informationUrl = InformationUrl.replace(/\{0\}/g, encodeURIComponent(applicationNumber));
                let developmentApplication = {
                    applicationNumber: applicationNumber,
                    address: address,
                    description: description,
                    informationUrl: informationUrl,
                    commentUrl: CommentUrl,
                    scrapeDate: moment().format("YYYY-MM-DD"),
                    receivedDate: receivedDate.isValid ? receivedDate.format("YYYY-MM-DD") : ""
                }
                let hasInserted = await insertRow(database, developmentApplication);
                if (!hasInserted)  // if not inserted because already existed
                    await updateRow(database, developmentApplication);
            }
        }

        // If there is no "next page" link then assume this is the last page.

        let hasNextPageLink = ($("ul.page-numbers li a.next").length > 0);
        if (!hasNextPageLink) {
            console.log("Reached the last page of the paged search results.");
            return;
        }
    }

    console.log(`Stopped because reached ${pageNumber} pages.`);
}

// Parses the development applications.

async function main() {
    // Read the suburb names.

    SuburbNames = {};
    for (let line of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let suburbTokens = line.toUpperCase().split(",");
        SuburbNames[suburbTokens[0].toUpperCase().trim()] = suburbTokens[1].toUpperCase().trim();
    }

    // Read the hundred names.

    HundredNames = [];
    for (let hundredName of fs.readFileSync("hundrednames.txt").toString().replace(/\r/g, "").trim().split("\n"))
        HundredNames.push(hundredName.toUpperCase().trim());

    // Ensure that the database exists.

    let database = await initializeDatabase();

    // Obtain the paged results of a search for the last month.

    await parse(moment().subtract(1, <moment.unitOfTime.DurationConstructor> "months"), moment(), database);
    await sleep(5000 + getRandom(0, 10) * 1000);

    // Obtain the paged results of a search for a randomly selected month (to build up over time
    // a complete picture of all development applications, while avoiding overloading the web
    // server with a lot of requests).

    let monthCount = moment().year() * 12 + moment().month() - (1997 * 12 + 4);  // first recorded development application is 16th April 1997
    let randomMonth = getRandom(1, monthCount + 1)
    await parse(moment().subtract(randomMonth + 1, <moment.unitOfTime.DurationConstructor> "months"), moment().subtract(randomMonth, <moment.unitOfTime.DurationConstructor> "months"), database);
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
