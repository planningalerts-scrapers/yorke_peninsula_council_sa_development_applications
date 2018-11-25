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

const DevelopmentApplicationsUrl = "https://yorke.sa.gov.au/development/development-information/development-register/?gv_search=&filter_1=&filter_3=&gv_start={0}&gv_end={1}&filter_7=&mode=all"
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

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();

    // Retrieve the results of a search for the last month.

    let dateFrom = encodeURIComponent(moment().subtract(1, "months").format("DD/MM/YYYY"));
    let dateTo = encodeURIComponent(moment().format("DD/MM/YYYY"));
    let developmentApplicationsUrl = DevelopmentApplicationsUrl.replace(/\{0\}/g, dateFrom).replace(/\{1\}/g, dateTo);
    console.log(`Retrieving page: ${developmentApplicationsUrl}`);
    let body = await request({ url: developmentApplicationsUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
    let $ = cheerio.load(body);

    // Parse the search results.

    for (let headerElement of $("h4.non_table_headers").get()) {
        let address: string = $(headerElement).text().trim().replace(/\s\s+/g, " ");  // reduce multiple consecutive spaces in the address to a single space
        let applicationNumber = "";
        let reason = "";
        let receivedDate = moment.invalid();

        for (let divElement of $(headerElement).next("div").get()) {
            for (let paragraphElement of $(divElement).find("p.rowDataOnly").get()) {
                let key: string = $(paragraphElement).children("span.key").text().trim();
                let value: string = $(paragraphElement).children("span.inputField").text().trim();
                if (key === "Type of Work")
                    reason = value;
                else if (key === "Application No.")
                    applicationNumber = value;
                else if (key === "Date Lodged")
                    receivedDate = moment(value, "D/MM/YYYY", true);  // allows the leading zero of the day to be omitted
            }
        }

        // Ensure that at least an application number and address have been obtained.

        if (applicationNumber !== "" && address !== "") {
            await insertRow(database, {
                applicationNumber: applicationNumber,
                address: address,
                reason: reason,
                informationUrl: DevelopmentApplicationsUrl,
                commentUrl: CommentUrl,
                scrapeDate: moment().format("YYYY-MM-DD"),
                receivedDate: receivedDate.isValid ? receivedDate.format("YYYY-MM-DD") : ""
            });
        }
    }
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
