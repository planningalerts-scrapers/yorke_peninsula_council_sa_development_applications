// Parses the development applications at the South Australian Yorke Peninsula Council web site
// and places them in a database.
//
// Michael Bone
// 25th November 2018
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const cheerio = require("cheerio");
const request = require("request-promise-native");
const sqlite3 = require("sqlite3");
const moment = require("moment");
const didyoumean = require("didyoumean2");
sqlite3.verbose();
const DevelopmentApplicationsUrl = "https://yorke.sa.gov.au/development/development-information/development-register/?pagenum={0}&gv_search=&filter_1=&filter_3=&gv_start={1}&gv_end={2}&filter_7=&mode=all";
const InformationUrl = "https://yorke.sa.gov.au/development/development-information/development-register/?gv_search=&filter_1={0}&filter_3=&gv_start=&gv_end=&filter_7=&mode=all";
const CommentUrl = "mailto:admin@yorke.sa.gov.au";
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
        ], function (error, row) {
            if (error) {
                console.error(error);
                reject(error);
            }
            else {
                sqlStatement.finalize(); // releases any locks
                if (this.changes > 0) {
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                    resolve(true); // indicate row was inserted
                }
                else {
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" because it was already present in the database.`);
                    resolve(false); // indicate row already existed so was not inserted
                }
            }
        });
    });
}
// Updates the inforation URL in a row in the database.
async function updateRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("update [data] set [info_url] = ? where [info_url] like 'https://yorke.sa.gov.au/development/development-information/development-register/entry/%' and [council_reference] = ?");
        sqlStatement.run([developmentApplication.informationUrl, developmentApplication.applicationNumber], function (error, row) {
            if (error) {
                console.error(error);
                reject(error);
            }
            else {
                sqlStatement.finalize(); // releases any locks
                resolve(row);
            }
        });
    });
}
// Gets a random integer in the specified range: [minimum, maximum).
function getRandom(minimum, maximum) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}
// Pauses for the specified number of milliseconds.
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
// Format the address, ensuring that it has a valid suburb name, state and post code.
function formatAddress(address) {
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
            tokens.splice(-index, index); // remove elements from the end of the array           
            break;
        }
    }
    if (suburbName === null) { // suburb name not found (or not recognised)
        console.log(`The state and post code will not be added because the suburb was not recognised: ${address}`);
        return address;
    }
    // Add the suburb name with its state and post code to the street name.
    let streetName = tokens.join(" ").trim();
    return (streetName + ((streetName === "") ? "" : ", ") + suburbName).trim();
}
// Parses the development applications in the specified date range.
async function parse(dateFrom, dateTo, database) {
    console.log(`Retrieving development applications from ${dateFrom.format("YYYY-MM-DD")} to ${dateTo.format("YYYY-MM-DD")}.`);
    let dateFromText = encodeURIComponent(dateFrom.format("DD/MM/YYYY"));
    let dateToText = encodeURIComponent(dateTo.format("DD/MM/YYYY"));
    // Step through each page of the results for the specified date range.
    let pageNumber = 0;
    while (pageNumber++ < 100) { // safety precaution
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
                };
                let hasInserted = await insertRow(database, developmentApplication);
                if (!hasInserted) // if not inserted because already existed
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
    await parse(moment().subtract(1, "months"), moment(), database);
    await sleep(5000 + getRandom(0, 10) * 1000);
    // Obtain the paged results of a search for a randomly selected month (to build up over time
    // a complete picture of all development applications, while avoiding overloading the web
    // server with a lot of requests).
    let monthCount = moment().year() * 12 + moment().month() - (1997 * 12 + 4); // first recorded development application is 16th April 1997
    let randomMonth = getRandom(1, monthCount + 1);
    await parse(moment().subtract(randomMonth + 1, "months"), moment().subtract(randomMonth, "months"), database);
}
main().then(() => console.log("Complete.")).catch(error => console.error(error));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NyYXBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNjcmFwZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsK0ZBQStGO0FBQy9GLGlDQUFpQztBQUNqQyxFQUFFO0FBQ0YsZUFBZTtBQUNmLHFCQUFxQjtBQUVyQixZQUFZLENBQUM7O0FBRWIseUJBQXlCO0FBQ3pCLG1DQUFtQztBQUNuQyxrREFBa0Q7QUFDbEQsbUNBQW1DO0FBQ25DLGlDQUFpQztBQUNqQywwQ0FBMEM7QUFFMUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO0FBRWxCLE1BQU0sMEJBQTBCLEdBQUcseUtBQXlLLENBQUM7QUFDN00sTUFBTSxjQUFjLEdBQUcsMEpBQTBKLENBQUM7QUFDbEwsTUFBTSxVQUFVLEdBQUcsOEJBQThCLENBQUM7QUFJbEQsdUJBQXVCO0FBRXZCLElBQUksV0FBVyxHQUFHLFNBQVMsQ0FBQztBQUM1QixJQUFJLFlBQVksR0FBRyxTQUFTLENBQUM7QUFFN0IsOEJBQThCO0FBRTlCLEtBQUssVUFBVSxrQkFBa0I7SUFDN0IsT0FBTyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtRQUNuQyxJQUFJLFFBQVEsR0FBRyxJQUFJLE9BQU8sQ0FBQyxRQUFRLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDbkQsUUFBUSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUU7WUFDcEIsUUFBUSxDQUFDLEdBQUcsQ0FBQywwT0FBME8sQ0FBQyxDQUFDO1lBQ3pQLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUN0QixDQUFDLENBQUMsQ0FBQztJQUNQLENBQUMsQ0FBQyxDQUFDO0FBQ1AsQ0FBQztBQUVELG1FQUFtRTtBQUVuRSxLQUFLLFVBQVUsU0FBUyxDQUFDLFFBQVEsRUFBRSxzQkFBc0I7SUFDckQsT0FBTyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtRQUNuQyxJQUFJLFlBQVksR0FB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